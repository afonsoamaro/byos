import { chmod, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { planBackup } from '../../src/backup/plan.js';
import { createReport, scan } from '../../src/backup/scan.js';
import { sha256File } from '../../src/local.js';
import { cleanupBackup, manifestFor, tmp, write } from './fixtures.js';

afterEach(cleanupBackup);

async function setup(files: Record<string, string>) {
  const folder = await tmp();
  const data = await tmp('byos-data-');
  await write(folder, files);
  const manifest = manifestFor(data, folder);
  const counted = { calls: 0 };
  const hash = async (path: string) => {
    counted.calls += 1;
    return sha256File(path);
  };
  const run = (dryRun: boolean, hasher = hash) => {
    const report = createReport();
    return planBackup({
      entries: scan(folder, {}, report),
      report,
      manifest,
      hash: hasher,
      dryRun,
    });
  };
  return { folder, manifest, counted, run, data };
}

const many = (n: number): Record<string, string> =>
  Object.fromEntries(
    Array.from({ length: n }, (_, i) => [
      `d${String(i % 10)}/f${String(i)}.txt`,
      `content ${String(i)}`,
    ]),
  );

/** Records every planned item as uploaded, as the upload step will. */
function markUploaded(
  manifest: ReturnType<typeof manifestFor>,
  items: readonly {
    relPath: string;
    size: number;
    mtimeMs: number;
    sha256: string;
  }[],
) {
  items.forEach((item, i) => {
    manifest.recordUpload(item.relPath, { ...item, driveId: `id-${String(i)}` }, 1);
  });
}

const dump = (path: string) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return JSON.stringify(db.prepare('SELECT * FROM files ORDER BY rel_path').all());
  } finally {
    db.close();
  }
};

describe('planBackup', () => {
  it('plans 1,000 new files, then plans nothing and hashes nothing once they are uploaded', async () => {
    const { manifest, counted, run } = await setup(many(1000));
    const first = await run(true);
    expect(first.found).toBe(1000);
    expect(first.toUpload).toHaveLength(1000);
    expect(counted.calls).toBe(1000);
    expect(first.bytes).toBe(first.toUpload.reduce((sum, item) => sum + item.size, 0));

    markUploaded(manifest, first.toUpload);
    counted.calls = 0;
    const second = await run(true);
    expect(second.toUpload).toHaveLength(0);
    expect(second.unchanged).toBe(1000);
    expect(counted.calls).toBe(0);
  });

  it('a dry run leaves the files table byte-identical, even when the time changed', async () => {
    const { folder, manifest, run } = await setup({ 'a.txt': 'one', 'b.txt': 'two' });
    markUploaded(manifest, (await run(true)).toUpload);
    await utimes(join(folder, 'a.txt'), new Date(2020, 1, 1), new Date(2020, 1, 1));
    const before = dump(manifest.path);
    const plan = await run(true);
    expect(plan.toUpload).toHaveLength(0);
    expect(dump(manifest.path)).toBe(before);
  });

  it('a touched file with the same content is hashed once, plans nothing, and its time is refreshed', async () => {
    const { folder, manifest, counted, run } = await setup({ 'a.txt': 'one', 'b.txt': 'two' });
    markUploaded(manifest, (await run(true)).toUpload);
    const touched = new Date(2021, 2, 3);
    await utimes(join(folder, 'a.txt'), touched, touched);
    counted.calls = 0;
    const plan = await run(false);
    expect(counted.calls).toBe(1);
    expect(plan.toUpload).toHaveLength(0);
    expect(manifest.get('a.txt')?.mtimeMs).toBe(touched.getTime());
    counted.calls = 0;
    await run(false);
    expect(counted.calls).toBe(0);
  });

  it('changed content with a stored Drive id is planned as a revision of that id', async () => {
    const { folder, manifest, run } = await setup({ 'a.txt': 'one' });
    markUploaded(manifest, (await run(true)).toUpload);
    await write(folder, { 'a.txt': 'one, edited' });
    const plan = await run(true);
    expect(plan.toUpload).toEqual([expect.objectContaining({ relPath: 'a.txt', driveId: 'id-0' })]);
  });

  it('a file that is not in the manifest has no Drive id yet', async () => {
    const { run } = await setup({ 'a.txt': 'one' });
    const [item] = (await run(true)).toUpload;
    expect(item).toBeDefined();
    expect(item).not.toHaveProperty('driveId');
  });

  it('a file that disappears between the scan and the hash is a warning, and the run goes on', async () => {
    const { run } = await setup({ 'a.txt': 'one', 'b.txt': 'two' });
    const plan = await run(true, (path) =>
      path.endsWith('a.txt')
        ? Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' }))
        : sha256File(path),
    );
    expect(plan.warnings.join()).toContain('a.txt disappeared');
    expect(plan.toUpload.map((i) => i.relPath)).toEqual(['b.txt']);
    expect(plan.found).toBe(1);
    expect(plan.errors).toEqual([]);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'a file that can not be read goes to errors and the run goes on',
    async () => {
      const { folder, run } = await setup({ 'a.txt': 'one', 'b.txt': 'two' });
      await chmod(join(folder, 'a.txt'), 0o000);
      const plan = await run(true, sha256File);
      expect(plan.errors).toEqual([expect.objectContaining({ relPath: 'a.txt', code: 'EACCES' })]);
      expect(plan.toUpload.map((i) => i.relPath)).toEqual(['b.txt']);
    },
  );

  it('files deleted locally stay in the manifest and produce no plan entry', async () => {
    const { manifest, run, folder } = await setup({ 'a.txt': 'one', 'b.txt': 'two' });
    markUploaded(manifest, (await run(true)).toUpload);
    const { rm } = await import('node:fs/promises');
    await rm(join(folder, 'a.txt'));
    const plan = await run(false);
    expect(plan).toMatchObject({ found: 1, unchanged: 1 });
    expect(plan.toUpload).toEqual([]);
    expect(manifest.get('a.txt')?.driveId).toMatch(/^id-/);
  });

  it('a manifest row that was never marked uploaded does not count as backed up', async () => {
    const { manifest, folder, run } = await setup({ 'a.txt': 'one' });
    const [item] = (await run(true)).toUpload;
    if (!item) throw new Error('expected one planned file');
    manifest.recordUpload('a.txt', { ...item, driveId: 'x' });
    // A row without an upload time (a future writer's half state) must be planned again.
    const db = new DatabaseSync(manifest.path);
    db.exec('UPDATE files SET uploaded_at = NULL');
    db.close();
    expect((await run(true)).toUpload).toHaveLength(1);
    expect(folder).toBeTruthy();
  });
});
