import { rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { AuthError, QuotaExceededError } from '@byos/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { planBackup } from '../../src/backup/plan.js';
import { createReport, scan } from '../../src/backup/scan.js';
import { runBackup, type RunResult } from '../../src/backup/upload.js';
import { cleanupBackup, manifestFor, tmp, write } from './fixtures.js';
import { ResumableMemory } from './resumable-memory.js';

afterEach(cleanupBackup);

const SLOW = Math.max(30_000, Number(process.env.BYOS_TEST_TIMEOUT) || 0);
const BASE = ['BYOS Backup', 'dev', 'pics'] as const;
const REMOTE = BASE.join('/');
const MIB = 1024 * 1024;

const bytes = (size: number, seed: number): Buffer => {
  const buffer = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) buffer[i] = (i * 31 + seed) % 251;
  return buffer;
};

async function setup(files: Record<string, string | Uint8Array>, provider = new ResumableMemory()) {
  const folder = await tmp();
  const data = await tmp('byos-data-');
  await write(folder, files);
  const manifest = manifestFor(data, folder);
  const plan = async (using = manifest) => {
    const report = createReport();
    return planBackup({
      entries: scan(folder, {}, report),
      report,
      manifest: using,
      dryRun: false,
    });
  };
  const run = async (
    extra: Partial<Parameters<typeof runBackup>[0]> = {},
    using = manifest,
  ): Promise<RunResult> =>
    runBackup({
      items: (await plan(using)).toUpload,
      manifest: using,
      provider,
      base: BASE,
      concurrency: 4,
      ...extra,
    });
  const remoteFiles = () =>
    provider.inner
      .snapshot()
      .filter((entry) => !entry.isFolder)
      .map((entry) => entry.path)
      .sort();
  const remoteBytes = async (rel: string): Promise<Buffer> =>
    Buffer.from(
      await new Response(await provider.inner.get({ path: `${REMOTE}/${rel}` })).arrayBuffer(),
    );
  return { folder, data, manifest, provider, plan, run, remoteFiles, remoteBytes };
}

/** Nothing the code under test did removed anything in Drive. */
const expectNoDelete = (provider: ResumableMemory): void => {
  expect(provider.calls.delete).toBe(0);
};

describe('runBackup: full runs', () => {
  it(
    'uploads 500 files of mixed sizes, mirrors the tree, and a second run uploads nothing',
    async () => {
      const files: Record<string, string | Uint8Array> = {};
      for (let i = 0; i < 498; i += 1)
        files[`d${String(i % 10)}/f${String(i)}.txt`] = `n${String(i)}`;
      files['big/a.bin'] = bytes(MIB + 300_000, 1);
      files['big/b.bin'] = bytes(2 * MIB + 17, 2);
      const t = await setup(files);

      const first = await t.run();
      expect(first).toMatchObject({ uploaded: 500, remaining: 0, partial: 0 });
      expect(first.failures).toEqual([]);
      expect(first.stoppedBy).toBeUndefined();
      const remote = t.remoteFiles();
      expect(remote).toHaveLength(500);
      expect(remote).toContain(`${REMOTE}/d3/f13.txt`);
      expect(remote).toContain(`${REMOTE}/big/b.bin`);
      expect(await t.remoteBytes('big/a.bin')).toEqual(bytes(MIB + 300_000, 1));
      for (const rel of Object.keys(files)) {
        expect(t.manifest.get(rel)?.driveId).toBeDefined();
        expect(t.manifest.session(rel)).toBeUndefined();
      }

      const puts = t.provider.calls.put;
      const second = await t.run();
      expect(second).toMatchObject({ uploaded: 0, remaining: 0 });
      expect(t.provider.calls.put).toBe(puts);
      expectNoDelete(t.provider);
    },
    SLOW,
  );

  it('makes a changed local file a new revision of the same Drive id', async () => {
    const t = await setup({ 'a.txt': 'first', 'keep.txt': 'same' });
    await t.run();
    const id = t.manifest.get('a.txt')?.driveId;
    expect(id).toBeDefined();

    await writeFile(join(t.folder, 'a.txt'), 'second version');
    await utimes(join(t.folder, 'a.txt'), new Date(), new Date(Date.now() + 5000));
    const result = await t.run();
    expect(result).toMatchObject({ uploaded: 1, remaining: 0 });
    expect(t.manifest.get('a.txt')?.driveId).toBe(id);
    expect(t.remoteFiles()).toEqual([`${REMOTE}/a.txt`, `${REMOTE}/keep.txt`]);
    expect((await t.remoteBytes('a.txt')).toString()).toBe('second version');
    expectNoDelete(t.provider);
  });

  it('uploads as new when the Drive copy is gone, and refuses when it was moved', async () => {
    const t = await setup({ 'a.txt': 'first', 'b.txt': 'bee' });
    await t.run();
    const a = t.manifest.get('a.txt')?.driveId ?? '';
    const b = t.manifest.get('b.txt')?.driveId ?? '';
    // a.txt is trashed in Drive; b.txt is renamed there.
    await t.provider.inner.delete({ id: a });
    await t.provider.inner.move({ id: b }, { name: 'renamed.txt' });
    for (const name of ['a.txt', 'b.txt']) {
      await writeFile(join(t.folder, name), `${name} changed`);
      await utimes(join(t.folder, name), new Date(), new Date(Date.now() + 5000));
    }
    const result = await t.run();
    expect(result.uploaded).toBe(1);
    expect(result.failures).toEqual([
      expect.objectContaining({ relPath: 'b.txt', code: 'REMOTE_CHANGED' }),
    ]);
    expect(t.manifest.get('a.txt')?.driveId).not.toBe(a);
    expect((await t.remoteBytes('renamed.txt')).toString()).toBe('bee');
  });
});

describe('runBackup: never overwrites what the manifest did not create', () => {
  it('adopts a same-name file with the same content when the manifest was lost', async () => {
    const t = await setup({ 'a.txt': 'hello' });
    await t.run();
    const fresh = manifestFor(await tmp('byos-data-'), t.folder);
    const result = await t.run({}, fresh);
    expect(result).toMatchObject({ uploaded: 1, remaining: 0 });
    expect(result.failures).toEqual([]);
    expect(t.remoteFiles()).toEqual([`${REMOTE}/a.txt`]);
    expect(fresh.get('a.txt')?.driveId).toBe(t.manifest.get('a.txt')?.driveId);
    expectNoDelete(t.provider);
  });

  it('fails the file, leaving Drive as it was, when the same name holds other content', async () => {
    const t = await setup({ 'a.txt': 'mine' });
    const folder = await t.provider.inner.mkdir({
      parent: { path: 'BYOS Backup/dev' },
      name: 'pics',
      parents: true,
    });
    await t.provider.inner.put({
      parent: { id: folder.id },
      name: 'a.txt',
      body: new TextEncoder().encode('someone else'),
      sha256: 'a'.repeat(64),
    });
    const result = await t.run();
    expect(result.uploaded).toBe(0);
    expect(result.failures).toEqual([
      expect.objectContaining({ relPath: 'a.txt', code: 'CONFLICT' }),
    ]);
    expect((await t.remoteBytes('a.txt')).toString()).toBe('someone else');
    expect(t.manifest.get('a.txt')).toBeUndefined();
    expectNoDelete(t.provider);
  });

  it('does not record a file when Drive reports different content', async () => {
    const t = await setup({ 'a.txt': 'hello', 'b.txt': 'there' });
    t.provider.nextSha256 = 'f'.repeat(64);
    const result = await t.run({ concurrency: 1 });
    // Which file is first depends on the folder listing order; one of them gets the bad hash.
    expect(result.failures).toEqual([expect.objectContaining({ code: 'HASH_MISMATCH' })]);
    expect(result.uploaded).toBe(1);
    const failed = result.failures[0]?.relPath ?? '';
    const other = failed === 'a.txt' ? 'b.txt' : 'a.txt';
    expect(t.manifest.get(failed)).toBeUndefined();
    expect(t.manifest.get(other)?.uploadedAt).toBeDefined();
  });

  it('fails a file that changed after the plan was made', async () => {
    const t = await setup({ 'a.txt': 'hello' });
    const items = (await t.plan()).toUpload;
    await writeFile(join(t.folder, 'a.txt'), 'edited meanwhile');
    await utimes(join(t.folder, 'a.txt'), new Date(), new Date(Date.now() + 5000));
    const result = await runBackup({
      items,
      manifest: t.manifest,
      provider: t.provider,
      base: BASE,
      concurrency: 1,
    });
    expect(result.failures).toEqual([expect.objectContaining({ code: 'CHANGED' })]);
    expect(t.manifest.get('a.txt')).toBeUndefined();
  });

  it('fails a file that disappeared after the plan was made, as a local I/O problem', async () => {
    const t = await setup({ 'a.txt': 'hello', 'b.txt': 'b' });
    const items = (await t.plan()).toUpload;
    await rm(join(t.folder, 'a.txt'));
    const result = await runBackup({
      items,
      manifest: t.manifest,
      provider: t.provider,
      base: BASE,
      concurrency: 1,
    });
    expect(result.failures).toEqual([
      expect.objectContaining({ relPath: 'a.txt', code: 'LOCAL_IO' }),
    ]);
    expect(result.uploaded).toBe(1);
  });
});

describe('runBackup: resume', () => {
  const large = bytes(MIB + 200_000, 7);

  it('resumes a killed upload from the offset Drive confirmed, with no duplicate', async () => {
    const t = await setup({ 'v/big.mov': large });
    t.provider.killAfterChunks = 2;
    const first = await t.run({ concurrency: 1 });
    expect(first.failures).toHaveLength(1);
    expect(first.partial).toBe(1);
    expect(t.manifest.get('v/big.mov')).toBeUndefined();
    expect(t.manifest.session('v/big.mov')?.offset).toBe(2 * 256 * 1024);
    expect(t.remoteFiles()).toEqual([]);

    const second = await t.run({ concurrency: 1 });
    expect(second).toMatchObject({ uploaded: 1, remaining: 0, partial: 0 });
    expect(t.provider.calls.resumeUpload).toBe(1);
    expect(t.provider.resumedFrom).toEqual([2 * 256 * 1024]);
    expect(t.remoteFiles()).toEqual([`${REMOTE}/v/big.mov`]);
    expect(await t.remoteBytes('v/big.mov')).toEqual(large);
    expect(t.manifest.session('v/big.mov')).toBeUndefined();
    expectNoDelete(t.provider);
  });

  it('starts over from zero when the saved session expired', async () => {
    const t = await setup({ 'big.mov': large });
    t.provider.killAfterChunks = 1;
    await t.run({ concurrency: 1 });
    t.provider.expireSessions = true;
    const puts = t.provider.calls.put;
    const result = await t.run({ concurrency: 1 });
    expect(result).toMatchObject({ uploaded: 1, remaining: 0 });
    expect(t.provider.calls.put).toBe(puts + 1);
    expect(t.remoteFiles()).toEqual([`${REMOTE}/big.mov`]);
    expect(await t.remoteBytes('big.mov')).toEqual(large);
    expect(t.manifest.session('big.mov')).toBeUndefined();
  });

  it('ignores a saved session when the file is not the one it was saved for', async () => {
    const t = await setup({ 'big.mov': large });
    t.provider.killAfterChunks = 1;
    await t.run({ concurrency: 1 });
    const edited = bytes(MIB + 200_000, 9);
    await writeFile(join(t.folder, 'big.mov'), edited);
    await utimes(join(t.folder, 'big.mov'), new Date(), new Date(Date.now() + 5000));
    const result = await t.run({ concurrency: 1 });
    expect(result.uploaded).toBe(1);
    expect(t.provider.calls.resumeUpload).toBe(0);
    expect(await t.remoteBytes('big.mov')).toEqual(edited);
  });
});

describe('runBackup: folders', () => {
  it('recreates a folder deleted in Drive between runs, and fixes the cache', async () => {
    const t = await setup({ 'a/b/x.txt': 'x', 'a/y.txt': 'y' });
    await t.run();
    const old = t.manifest.folderId('a');
    expect(old).toBeDefined();
    await t.provider.inner.delete({ id: old ?? '' }, { permanent: true });

    await write(t.folder, { 'a/b/z.txt': 'z' });
    const result = await t.run();
    expect(result).toMatchObject({ uploaded: 1, remaining: 0 });
    expect(result.failures).toEqual([]);
    expect(t.remoteFiles()).toEqual([`${REMOTE}/a/b/z.txt`]);
    expect(t.manifest.folderId('a')).toBeDefined();
    expect(t.manifest.folderId('a')).not.toBe(old);
    expectNoDelete(t.provider);
  });

  it('recreates the whole backup folder when it is gone', async () => {
    const t = await setup({ 'a.txt': 'x' });
    await t.run();
    await t.provider.inner.delete({ id: t.manifest.folderId('') ?? '' }, { permanent: true });
    await write(t.folder, { 'b.txt': 'y' });
    const result = await t.run();
    expect(result).toMatchObject({ uploaded: 1, remaining: 0 });
    expect(t.remoteFiles()).toEqual([`${REMOTE}/b.txt`]);
  });

  it('creates a shared folder once when many files need it at the same time', async () => {
    const files = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`deep/er/f${String(i)}.txt`, String(i)]),
    );
    const t = await setup(files);
    await t.run({ concurrency: 8 });
    const folders = t.provider.inner.snapshot().filter((entry) => entry.isFolder);
    expect(folders.map((f) => f.path).sort()).toEqual([
      'BYOS Backup',
      'BYOS Backup/dev',
      REMOTE,
      `${REMOTE}/deep`,
      `${REMOTE}/deep/er`,
    ]);
  });
});

describe('runBackup: stops', () => {
  it('stops the whole run on a full Drive and keeps what was already recorded', async () => {
    const files = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`f${String(i)}.txt`, `c${String(i)}`]),
    );
    const t = await setup(files);
    let puts = 0;
    t.provider.gate = () => {
      puts += 1;
      if (puts === 4) t.provider.inner.failNext('put', new QuotaExceededError('full'));
      return Promise.resolve();
    };
    const result = await t.run({ concurrency: 1 });
    expect(result.stoppedBy).toBe('quota');
    expect(result.stopError).toBeInstanceOf(QuotaExceededError);
    expect(result).toMatchObject({ uploaded: 3, remaining: 7 });
    expect(result.failures).toEqual([]);
    expect(t.remoteFiles()).toHaveLength(3);
    expect(t.provider.calls.put).toBe(4);
    for (const rel of t.remoteFiles().map((path) => path.slice(REMOTE.length + 1))) {
      expect(t.manifest.get(rel)?.uploadedAt).toBeDefined();
    }
    expectNoDelete(t.provider);

    // The next run finishes the rest.
    t.provider.gate = undefined;
    expect(await t.run()).toMatchObject({ uploaded: 7, remaining: 0 });
    expect(t.remoteFiles()).toHaveLength(10);
  });

  it('stops the whole run when Google refuses the sign-in', async () => {
    const t = await setup({ 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' });
    t.provider.inner.failNext('put', new AuthError('signed out', { reason: 'invalid-grant' }));
    const result = await t.run({ concurrency: 1 });
    expect(result.stoppedBy).toBe('auth');
    expect(result.stopError).toBeInstanceOf(AuthError);
    expect(result).toMatchObject({ uploaded: 0, remaining: 3 });
    expect(result.failures).toEqual([]);
    expect(t.provider.calls.put).toBe(1);
  });

  it('on Ctrl+C keeps the session of an upload still running, for the next run', async () => {
    const t = await setup({ 'v/big.mov': bytes(MIB + 200_000, 4) });
    const controller = new AbortController();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.provider.chunkGate = () => held;
    const running = t.run({ concurrency: 1, signal: controller.signal, graceMs: 30 });
    await vi.waitFor(() => {
      expect(t.manifest.session('v/big.mov')?.offset).toBe(256 * 1024);
    });
    controller.abort();
    const result = await running;
    expect(result).toMatchObject({ stoppedBy: 'interrupt', uploaded: 0, remaining: 1, partial: 1 });
    expect(t.manifest.get('v/big.mov')).toBeUndefined();
    t.provider.chunkGate = undefined;
    t.manifest.close();
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it('keeps going past a failed file', async () => {
    const t = await setup({ 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' });
    t.provider.inner.failNext('put', new Error('boom'));
    const result = await t.run({ concurrency: 1 });
    expect(result.uploaded).toBe(2);
    expect(result.failures).toEqual([expect.objectContaining({ code: 'UNEXPECTED' })]);
    expect(result.remaining).toBe(0);
  });

  it('on Ctrl+C stops starting files, lets running ones finish, and resumes cleanly', async () => {
    const files = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [`f${String(i)}.txt`, `c${String(i)}`]),
    );
    const t = await setup(files);
    const controller = new AbortController();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.provider.gate = () => held;
    const running = t.run({ concurrency: 2, signal: controller.signal });
    await vi.waitFor(() => {
      expect(t.provider.calls.put).toBe(2);
    });
    controller.abort();
    release();
    const result = await running;
    expect(result.stoppedBy).toBe('interrupt');
    expect(result).toMatchObject({ uploaded: 2, remaining: 6 });
    expect(t.provider.calls.put).toBe(2);
    // The manifest and Drive agree on what is there.
    const recorded = Object.keys(files).filter((rel) => t.manifest.get(rel) !== undefined);
    expect(recorded.map((rel) => `${REMOTE}/${rel}`).sort()).toEqual(t.remoteFiles());

    t.provider.gate = undefined;
    expect(await t.run()).toMatchObject({ uploaded: 6, remaining: 0 });
    expect(t.remoteFiles()).toHaveLength(8);
    expectNoDelete(t.provider);
  });

  it('returns within the grace period even when an upload does not settle', async () => {
    const t = await setup({ 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' });
    const controller = new AbortController();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.provider.gate = () => held;
    const running = t.run({ concurrency: 2, signal: controller.signal, graceMs: 30 });
    await vi.waitFor(() => {
      expect(t.provider.calls.put).toBe(2);
    });
    controller.abort();
    const result = await running;
    expect(result).toMatchObject({ stoppedBy: 'interrupt', uploaded: 0, remaining: 3 });

    // An upload that finishes after the run returned must not write to the manifest.
    t.manifest.close();
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(t.provider.inner.snapshot().filter((entry) => !entry.isFolder)).not.toHaveLength(0);
  });
});

describe('runBackup: concurrency', () => {
  it('runs as many uploads at once as asked, and no more', async () => {
    const files = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`f${String(i)}.txt`, String(i)]),
    );
    const t = await setup(files);
    t.provider.gate = () => new Promise((resolve) => setTimeout(resolve, 5));
    await t.run({ concurrency: 16 });
    expect(t.provider.maxInFlight).toBe(16);
    expect(t.remoteFiles()).toHaveLength(40);
  });
});
