import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createReport, scan, type ScanOptions } from '../../src/backup/scan.js';
import { cleanupBackup, tmp, write } from './fixtures.js';

afterEach(cleanupBackup);

// What this machine's file system can tell apart, probed once. APFS and NTFS ignore case, and
// APFS also treats composed and decomposed names as one, so those tests only run elsewhere.
async function probe(first: string, second: string): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), 'byos-probe-'));
  try {
    await writeFile(join(dir, first), '1');
    await writeFile(join(dir, second), '2');
    return (await readdir(dir)).length === 2;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const caseSensitive = await probe('A', 'a');
const normalizationSensitive = await probe('\u00e9', 'e\u0301');

async function run(root: string, options: ScanOptions = {}) {
  const report = createReport();
  const entries = [];
  for await (const entry of scan(root, options, report)) entries.push(entry);
  return { paths: entries.map((e) => e.relPath).sort(), entries, report };
}

describe('scan', () => {
  it('yields nested files with POSIX relative paths, sizes and times', async () => {
    const root = await tmp();
    await write(root, { 'a.txt': 'abc', 'x/y/z.bin': '12345678' });
    const { paths, entries } = await run(root);
    expect(paths).toEqual(['a.txt', 'x/y/z.bin']);
    expect(entries.find((e) => e.relPath === 'x/y/z.bin')).toMatchObject({ size: 8 });
    expect(entries[0]?.mtimeMs).toBeGreaterThan(0);
  });

  it('skips the files the systems write on their own, and hidden names, and says why', async () => {
    const root = await tmp();
    await write(root, {
      'keep.jpg': 'k',
      'Thumbs.db': 't',
      'desktop.ini': 'd',
      '.DS_Store': 's',
      '._keep.jpg': 'a',
      '.hidden-file': 'h',
      '.hidden-dir/inside.jpg': 'i',
      'sub/THUMBS.DB': 't',
    });
    const { paths, report } = await run(root);
    expect(paths).toEqual(['keep.jpg']);
    const reasons = Object.fromEntries(report.skipped.map((s) => [s.relPath, s.reason]));
    expect(reasons).toMatchObject({
      'Thumbs.db': 'system',
      'desktop.ini': 'system',
      '.DS_Store': 'system',
      '._keep.jpg': 'hidden',
      '.hidden-file': 'hidden',
      '.hidden-dir': 'hidden',
      'sub/THUMBS.DB': 'system',
    });
  });

  it('applies --exclude globs to files and prunes whole folders', async () => {
    const root = await tmp();
    await write(root, {
      'a.jpg': '1',
      'a.tmp': '2',
      'deep/b.tmp': '3',
      'deep/b.jpg': '4',
      'raw/x.cr2': '5',
      'raw/sub/y.cr2': '6',
    });
    const { paths, report } = await run(root, { exclude: ['**/*.tmp', 'raw/**'] });
    expect(paths).toEqual(['a.jpg', 'deep/b.jpg']);
    expect(
      report.skipped
        .filter((s) => s.reason === 'excluded')
        .map((s) => s.relPath)
        .sort(),
    ).toEqual(['a.tmp', 'deep/b.tmp', 'raw']);
  });

  it.skipIf(process.platform === 'win32')(
    'does not follow symlinks to files or folders, and reports them',
    async () => {
      const outside = await tmp();
      await write(outside, { 'secret.txt': 'do not copy' });
      const root = await tmp();
      await write(root, { 'real.txt': 'r' });
      await symlink(join(outside, 'secret.txt'), join(root, 'link-file'));
      await symlink(outside, join(root, 'link-dir'));
      const { paths, report } = await run(root);
      expect(paths).toEqual(['real.txt']);
      expect(
        report.skipped
          .filter((s) => s.reason === 'symlink')
          .map((s) => s.relPath)
          .sort(),
      ).toEqual(['link-dir', 'link-file']);
    },
  );

  it('turns a decomposed (NFD) file name into a composed (NFC) relative path', async () => {
    const root = await tmp();
    const nfd = 'Férias.jpg';
    await write(root, { [nfd]: 'x' });
    const { entries } = await run(root);
    expect(entries[0]?.relPath).toBe('Férias.jpg');
    // The path used to read the file stays the one the file system has.
    expect(entries[0]?.absPath.endsWith(nfd) || entries[0]?.absPath.endsWith('Férias.jpg')).toBe(
      true,
    );
  });

  it.skipIf(!caseSensitive)(
    'warns about names that differ only by case, and keeps both',
    async () => {
      const root = await tmp();
      await write(root, { 'A.jpg': '1', 'a.jpg': '2' });
      const { paths, report } = await run(root);
      expect(paths).toEqual(['A.jpg', 'a.jpg']);
      expect(report.warnings.join()).toContain('differ only by case');
    },
  );

  it.skipIf(!normalizationSensitive)(
    'skips the second of two names that are equal after NFC, with a warning',
    async () => {
      const root = await tmp();
      await write(root, { '\u00e9.jpg': '1', 'e\u0301.jpg': '2' });
      const { paths, report } = await run(root);
      expect(paths).toEqual(['\u00e9.jpg']);
      expect(report.skipped).toEqual([{ relPath: '\u00e9.jpg', reason: 'duplicate' }]);
      expect(report.warnings.join()).toContain('appears twice');
    },
  );

  it('handles a path longer than 260 characters', async () => {
    const root = await tmp();
    const deep = Array.from({ length: 6 }, (_, i) => `${'d'.repeat(50)}${String(i)}`).join('/');
    await mkdir(join(root, deep), { recursive: true });
    await write(root, { [`${deep}/photo.jpg`]: 'x' });
    const { entries } = await run(root);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.relPath.length).toBeGreaterThan(260);
    expect(entries[0]?.relPath).toBe(`${deep}/photo.jpg`);
  });

  it('reports a folder that can not be opened and goes on', async () => {
    const root = await tmp();
    await write(root, { 'ok.txt': 'o', 'locked/in.txt': 'i' });
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const { chmod } = await import('node:fs/promises');
    await chmod(join(root, 'locked'), 0o000);
    try {
      const { paths, report } = await run(root);
      expect(paths).toEqual(['ok.txt']);
      expect(report.errors).toEqual([
        expect.objectContaining({ relPath: 'locked', code: 'EACCES' }),
      ]);
    } finally {
      await chmod(join(root, 'locked'), 0o700);
    }
  });
});
