import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { manifestFileName, openManifest } from '../../src/backup/manifest.js';
import { main } from '../../src/main.js';
import { dataDir } from '../../src/store/paths.js';
import { cleanup, harness } from '../helpers.js';
import { cleanupBackup, tmp, write } from './fixtures.js';

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('real fetch called: a dry run must not touch the network');
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await cleanup();
  await cleanupBackup();
});

async function setup(files: Record<string, string>) {
  const t = await harness();
  const folder = await tmp();
  await write(folder, files);
  const data = dataDir({ platform: t.io.platform, env: t.io.env, homedir: t.io.homedir });
  return { t, folder, data };
}

describe('byos backup --dry-run', () => {
  it('prints the PP-02 plan for a first run and writes nothing', async () => {
    const { t, folder, data } = await setup({
      '2026/10/a.jpg': 'aaaa',
      '2026/10/b.jpg': 'bb',
      'c.mov': 'c',
      '.hidden': 'h',
    });
    expect(await main(['backup', folder, '--dry-run', '--device', 'laptop'], t.io)).toBe(0);
    const out = t.stdout();
    expect(out).toContain(`Scanning ${folder}`);
    expect(out).toMatch(/^ {2}3 files found$/m);
    expect(out).toMatch(/^ {2}0 unchanged$/m);
    expect(out).toMatch(/^ {2}3 to upload \(7 B\)$/m);
    expect(out).toMatch(/^ {2}1 skipped \(hidden 1\)$/m);
    expect(out).toMatch(/^ {2}remote BYOS Backup\/laptop\/[^/\n]+$/m);
    expect(out).toContain('Would upload 3 files (7 B):');
    expect(out).toContain('2026/10/a.jpg');
    expect(out).not.toContain('and');
    expect(t.stderr()).toBe('');
    // A dry run creates no manifest and nothing else in the data folder.
    await expect(readdir(data)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('shows six examples and the rest as a count', async () => {
    const files = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`f${String(i)}.txt`, 'x']),
    );
    const { t, folder } = await setup(files);
    await main(['backup', folder, '--dry-run'], t.io);
    expect(t.stdout()).toContain('Would upload 10 files (10 B):');
    expect(t.stdout()).toContain('… and 4 more');
    expect(t.stdout().match(/^ {2}f\d\.txt/gm)).toHaveLength(6);
  });

  it('--json gives the plan object and nothing else on stdout', async () => {
    const { t, folder } = await setup({ 'a.txt': 'a', 'x/b.txt': 'bb', 'Thumbs.db': 't' });
    expect(await main(['backup', folder, '--dry-run', '--json'], t.io)).toBe(0);
    const plan = JSON.parse(t.stdout()) as Record<string, unknown>;
    expect(Object.keys(plan).sort()).toEqual([
      'bytes',
      'errors',
      'found',
      'skipped',
      'toUpload',
      'unchanged',
      'warnings',
    ]);
    expect(plan).toMatchObject({
      found: 2,
      unchanged: 0,
      bytes: 3,
      skipped: [{ relPath: 'Thumbs.db', reason: 'system' }],
      warnings: [],
      errors: [],
    });
    expect((plan.toUpload as string[]).slice().sort()).toEqual(['a.txt', 'x/b.txt']);
  });

  it('counts a file as unchanged once the manifest says it was uploaded, and leaves the manifest alone', async () => {
    const { t, folder, data } = await setup({ 'a.txt': 'aaa', 'b.txt': 'bb' });
    await main(['backup', folder, '--dry-run', '--device', 'laptop', '--json'], t.io);
    const planned = JSON.parse(t.stdout()) as { toUpload: string[] };
    expect(planned.toUpload).toHaveLength(2);
    const key = { folder, device: 'laptop', remoteRoot: 'BYOS Backup' };
    const manifest = openManifest({ dataDir: data, ...key });
    const { lstatSync } = await import('node:fs');
    for (const rel of ['a.txt', 'b.txt']) {
      const info = lstatSync(join(folder, rel));
      manifest.recordUpload(
        rel,
        { size: info.size, mtimeMs: info.mtimeMs, sha256: 'x', driveId: 'd' },
        1,
      );
    }
    manifest.close();
    const t2 = await harness();
    await main(['backup', folder, '--dry-run', '--device', 'laptop', '--json'], {
      ...t2.io,
      env: t.io.env,
      homedir: t.io.homedir,
    });
    expect(JSON.parse(t2.stdout())).toMatchObject({ found: 2, unchanged: 2, toUpload: [] });
    expect(await readdir(join(data, 'manifests'))).toEqual([manifestFileName(key)]);
  });

  it('--exclude is repeatable', async () => {
    const { t, folder } = await setup({ 'a.jpg': '1', 'b.tmp': '2', 'raw/c.cr2': '3' });
    await main(
      ['backup', folder, '--dry-run', '--json', '--exclude', '**/*.tmp', '--exclude', 'raw/**'],
      t.io,
    );
    expect(JSON.parse(t.stdout())).toMatchObject({ toUpload: ['a.jpg'] });
  });

  it('without --dry-run it says uploading is not here yet (exit 2)', async () => {
    const { t, folder } = await setup({ 'a.txt': 'a' });
    expect(await main(['backup', folder], t.io)).toBe(2);
    expect(t.stderr()).toContain('use --dry-run');
  });

  it('a folder that does not exist, or is a file, is a usage error', async () => {
    const { t, folder } = await setup({ 'a.txt': 'a' });
    expect(await main(['backup', join(folder, 'nope'), '--dry-run'], t.io)).toBe(2);
    expect(await main(['backup', join(folder, 'a.txt'), '--dry-run'], t.io)).toBe(2);
  });

  it('a backslash in --remote-root is refused', async () => {
    const { t, folder } = await setup({ 'a.txt': 'a' });
    expect(await main(['backup', folder, '--dry-run', '--remote-root', 'a\\b'], t.io)).toBe(2);
  });

  it('exits 1 when a file could not be read, and still prints the plan', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const { chmod } = await import('node:fs/promises');
    const { t, folder } = await setup({ 'ok.txt': 'o', 'locked.txt': 'l' });
    await chmod(join(folder, 'locked.txt'), 0o000);
    expect(await main(['backup', folder, '--dry-run'], t.io)).toBe(1);
    expect(t.stdout()).toContain('Would upload 1 files');
    expect(t.stderr()).toContain('locked.txt can not be read (EACCES)');
  });

  it('never prints control characters from a file name', async () => {
    const { t, folder } = await setup({ 'a\u001b[2Jb.txt': 'x' });
    await main(['backup', folder, '--dry-run'], t.io);
    expect(t.stdout()).toContain('a?[2Jb.txt');
    expect(t.stdout()).not.toContain('\u001b');
  });
});
