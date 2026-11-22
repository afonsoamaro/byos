import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { AuthError, ProviderError } from '@byos/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openManifestReadOnly } from '../../src/backup/manifest.js';
import { verifyBackup } from '../../src/backup/verify.js';
import { main } from '../../src/main.js';
import { dataDir } from '../../src/store/paths.js';
import { cleanup, harness } from '../helpers.js';
import { cleanupBackup, tmp, write } from './fixtures.js';
import { ResumableMemory } from './resumable-memory.js';

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('real fetch called: the verify tests use an in-memory provider');
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await cleanup();
  await cleanupBackup();
});

const FILES = {
  'a.txt': 'alpha',
  'b.txt': 'bravo',
  'c.txt': 'charlie',
  'd.txt': 'delta',
  'e.txt': 'echo',
  'f.txt': 'foxtrot',
};

/** The backup that ran first also wrote to the same capture; the report is the last line. */
const lastLine = (text: string): string => text.trimEnd().split('\n').at(-1) ?? '';

/** A folder with six files, already backed up into the fake Drive. */
async function backedUp(files: Record<string, string> = FILES) {
  const provider = new ResumableMemory();
  const t = await harness({ memory: provider });
  const folder = await tmp();
  await write(folder, files);
  expect(await main(['backup', folder, '--device', 'laptop'], t.io)).toBe(0);
  const remote = `BYOS Backup/laptop/${basename(folder)}`;
  const idOf = async (rel: string): Promise<string> => {
    const stat = await provider.inner.stat({ path: `${remote}/${rel}` });
    if (!stat) throw new Error(`${rel} is not in the fake Drive`);
    return stat.id;
  };
  const verify = (...args: string[]) =>
    main(['backup', folder, '--verify', '--device', 'laptop', ...args], t.io);
  const data = dataDir({ platform: t.io.platform, env: t.io.env, homedir: t.io.homedir });
  return { t, provider, folder, remote, idOf, verify, data };
}

/** Moves b, deletes c for good, trashes d, rewrites e, and makes f unreadable. */
async function tamper(b: Awaited<ReturnType<typeof backedUp>>) {
  const { provider, idOf, remote } = b;
  const elsewhere = await provider.inner.mkdir({
    parent: { path: 'Elsewhere' },
    name: 'sub',
    parents: true,
  });
  await provider.inner.move(
    { id: await idOf('b.txt') },
    { parent: { id: elsewhere.id }, name: 'renamed.txt' },
  );
  await provider.inner.delete({ id: await idOf('c.txt') }, { permanent: true });
  await provider.inner.delete({ id: await idOf('d.txt') });
  const parent = await provider.inner.stat({ path: remote });
  await provider.inner.put({
    parent: { id: parent?.id ?? '' },
    name: 'e.txt',
    body: new TextEncoder().encode('someone changed this'),
    sha256: 'b'.repeat(64),
    overwrite: true,
  });
  provider.inspectFails.set(await idOf('f.txt'), new ProviderError('Drive is having a bad day'));
}

describe('byos backup --verify', () => {
  it('says so and exits 0 when every file is in Drive as uploaded', async () => {
    const b = await backedUp();
    expect(await b.verify()).toBe(0);
    expect(b.t.stdout()).toContain('Verifying 6 files against BYOS Backup/laptop/');
    expect(b.t.stdout()).toMatch(/^ {2}6 ok$/m);
    expect(b.t.stdout()).toContain('All 6 files are in Drive with the content that was uploaded.');
    expect(b.t.stderr()).toBe('');
  });

  it('with --json prints one report object', async () => {
    const b = await backedUp();
    expect(await b.verify('--json')).toBe(0);
    expect(JSON.parse(lastLine(b.t.stdout()))).toEqual({
      ok: 6,
      missing: [],
      trashed: [],
      mismatch: [],
      errors: [],
    });
  });

  it('puts each problem in its own category, counts a rename or move as ok, and exits 1', async () => {
    const b = await backedUp();
    await tamper(b);
    expect(await b.verify('--json')).toBe(1);
    expect(JSON.parse(lastLine(b.t.stdout()))).toEqual({
      ok: 2,
      missing: ['c.txt'],
      trashed: ['d.txt'],
      mismatch: ['e.txt'],
      errors: [{ relPath: 'f.txt', code: 'PROVIDER_ERROR', message: 'Drive is having a bad day' }],
    });
  });

  it('lists the problem files in the human report', async () => {
    const b = await backedUp();
    await tamper(b);
    expect(await b.verify()).toBe(1);
    const out = b.t.stdout();
    expect(out).toMatch(/^ {2}2 ok$/m);
    expect(out).toMatch(/^ {2}1 missing in Drive$/m);
    expect(out).toMatch(/^ {2}1 in the Drive trash$/m);
    expect(out).toMatch(/^ {2}1 different content in Drive$/m);
    expect(out).toMatch(/^ {2}1 could not be checked$/m);
    expect(out).toMatch(/^✗ missing {3}c\.txt$/m);
    expect(out).toMatch(/^✗ trashed {3}d\.txt$/m);
    expect(out).toMatch(/^✗ mismatch {2}e\.txt$/m);
    expect(out).toMatch(/^✗ error {5}f\.txt \(PROVIDER_ERROR\)$/m);
    expect(out).toContain('4 of 6 files need attention.');
  });

  it('only looks: no write to Drive and no change to the manifest', async () => {
    const b = await backedUp();
    await tamper(b);
    const manifestFile = join(
      b.data,
      'manifests',
      (await readdir(join(b.data, 'manifests')))[0] ?? '',
    );
    const before = await readFile(manifestFile);
    const listing = await readdir(join(b.data, 'manifests'));
    const writes = () => {
      const { put, mkdir, move, copy, delete: del, resumeUpload } = b.provider.calls;
      return [put, mkdir, move, copy, del, resumeUpload];
    };
    const writesBefore = writes();
    const inspectBefore = b.provider.calls.inspect;

    await b.verify();

    expect(writes()).toEqual(writesBefore);
    // Control: the verify really did look at every row, one lookup each.
    expect(b.provider.calls.inspect - inspectBefore).toBe(6);
    expect((await readFile(manifestFile)).equals(before)).toBe(true);
    expect(await readdir(join(b.data, 'manifests'))).toEqual(listing);
  });

  it('stops with exit 5 when Google refuses the sign-in', async () => {
    const b = await backedUp();
    b.provider.inspectFails.set(
      await b.idOf('a.txt'),
      new AuthError('signed out', { reason: 'invalid-grant' }),
    );
    expect(await b.verify()).toBe(5);
    expect(b.t.stderr()).toContain('AUTH_FAILED');
  });

  it('exits 2 for a folder that was never backed up, and creates nothing', async () => {
    const b = await backedUp();
    const other = await tmp();
    expect(await main(['backup', other, '--verify', '--device', 'laptop'], b.t.io)).toBe(2);
    expect(b.t.stderr()).toContain('no backup found for this folder; run byos backup first');
    expect(
      openManifestReadOnly({
        dataDir: b.data,
        folder: other,
        device: 'laptop',
        remoteRoot: 'BYOS Backup',
      }),
    ).toBeUndefined();
  });

  it('refuses --verify together with --dry-run (exit 2) without touching Drive', async () => {
    const b = await backedUp();
    const before = b.provider.calls.inspect;
    expect(await b.verify('--dry-run')).toBe(2);
    expect(b.t.stderr()).toContain('--verify and --dry-run can not be combined');
    expect(b.provider.calls.inspect).toBe(before);
  });
});

describe('verifyBackup with a provider that can not see the trash', () => {
  it('falls back to stat, where a trashed file counts as missing', async () => {
    const b = await backedUp({ 'a.txt': 'alpha', 'b.txt': 'bravo' });
    await b.provider.inner.delete({ id: await b.idOf('b.txt') });
    const manifest = openManifestReadOnly({
      dataDir: b.data,
      folder: b.folder,
      device: 'laptop',
      remoteRoot: 'BYOS Backup',
    });
    const rows = manifest?.allUploaded() ?? [];
    manifest?.close();
    expect(rows).toHaveLength(2);
    // The plain MemoryProvider has no `inspect`.
    const report = await verifyBackup({ rows, provider: b.provider.inner, concurrency: 2 });
    expect(report).toEqual({ ok: 1, missing: ['b.txt'], trashed: [], mismatch: [], errors: [] });
  });
});
