import { describe, expect, it } from 'vitest';

import {
  ConflictError,
  NotFoundError,
  ProviderError,
  QuotaExceededError,
  type FileRef,
  type StorageProvider,
} from '../src/index.js';
import { MemoryProvider } from '../src/testing/index.js';

const bytes = (text: string) => new TextEncoder().encode(text);

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

function provider() {
  let tick = 0;
  return new MemoryProvider({
    now: () => new Date(Date.UTC(2026, 10, 1, 0, 0, tick++)).toISOString(),
  });
}

describe('types', () => {
  it('MemoryProvider implements StorageProvider and FileRef is exclusive', () => {
    const p: StorageProvider = new MemoryProvider();
    // @ts-expect-error: a FileRef has an id or a path, never both.
    const both: FileRef = { id: 'a', path: 'b' };
    // @ts-expect-error: a FileRef needs one of them.
    const neither: FileRef = {};
    expect([p.name, both, neither]).toHaveLength(3);
  });
});

describe('put, stat and get', () => {
  it.each([
    ['Uint8Array', () => bytes('hello')],
    ['Blob', () => new Blob([bytes('hello')])],
    ['ReadableStream', () => new Blob([bytes('hel'), bytes('lo')]).stream()],
  ])('round-trips a %s body', async (_kind, body) => {
    const p = provider();
    const put = await p.put({
      parent: { path: '' },
      name: 'a.txt',
      body: body(),
      mimeType: 'text/plain',
      sha256: 'abc',
      appProperties: { byosVersion: '1' },
    });
    expect(put).toMatchObject({ name: 'a.txt', isFolder: false, size: 5, sha256: 'abc' });
    expect(put.parents).toEqual(['root']);
    expect(await p.stat({ id: put.id })).toEqual(put);
    expect(await p.stat({ path: 'a.txt' })).toEqual(put);
    expect(await readAll(await p.get({ id: put.id }))).toBe('hello');
  });

  it('refuses a same-name file unless overwrite is set, which keeps the id', async () => {
    const p = provider();
    const first = await p.put({ parent: { id: 'root' }, name: 'a.txt', body: bytes('one') });
    await expect(
      p.put({ parent: { id: 'root' }, name: 'a.txt', body: bytes('two') }),
    ).rejects.toBeInstanceOf(ConflictError);
    const second = await p.put({
      parent: { id: 'root' },
      name: 'a.txt',
      body: bytes('two!'),
      overwrite: true,
    });
    expect(second.id).toBe(first.id);
    expect(second.size).toBe(4);
    expect(await readAll(await p.get({ id: first.id }))).toBe('two!');
  });

  it('stat resolves to undefined for a missing file', async () => {
    const p = provider();
    expect(await p.stat({ id: 'nope' })).toBeUndefined();
    expect(await p.stat({ path: 'a/b.txt' })).toBeUndefined();
  });

  it('get refuses a folder, and a missing file is NotFound', async () => {
    const p = provider();
    const folder = await p.mkdir({ parent: { id: 'root' }, name: 'f' });
    await expect(p.get({ id: folder.id })).rejects.toBeInstanceOf(ProviderError);
    await expect(p.get({ id: 'nope' })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses . and .. path segments', async () => {
    await expect(provider().stat({ path: 'a/../b' })).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('list', () => {
  it('pages through children sorted by name', async () => {
    const p = provider();
    for (const name of ['c', 'a', 'b']) {
      await p.put({ parent: { id: 'root' }, name, body: bytes(name) });
    }
    const first = await p.list({ parent: { id: 'root' }, pageSize: 2 });
    expect(first.items.map((item) => item.name)).toEqual(['a', 'b']);
    expect(first.nextPageToken).toBeDefined();
    const second = await p.list({
      parent: { id: 'root' },
      pageSize: 2,
      pageToken: first.nextPageToken ?? '',
    });
    expect(second.items.map((item) => item.name)).toEqual(['c']);
    expect(second.nextPageToken).toBeUndefined();
  });
});

describe('mkdir', () => {
  it('is idempotent and creates missing parents only when asked', async () => {
    const p = provider();
    await expect(
      p.mkdir({ parent: { path: 'Backup/PC' }, name: 'Pictures' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    const made = await p.mkdir({ parent: { path: 'Backup/PC' }, name: 'Pictures', parents: true });
    const again = await p.mkdir({ parent: { path: 'Backup/PC' }, name: 'Pictures', parents: true });
    expect(again.id).toBe(made.id);
    expect(made.isFolder).toBe(true);
    expect(p.snapshot().map((entry) => entry.path)).toEqual([
      'Backup',
      'Backup/PC',
      'Backup/PC/Pictures',
    ]);
  });
});

describe('move and copy', () => {
  it('moves and renames keeping the id, and refuses a name clash', async () => {
    const p = provider();
    const dir = await p.mkdir({ parent: { id: 'root' }, name: 'dir' });
    const file = await p.put({ parent: { id: 'root' }, name: 'a.txt', body: bytes('a') });
    await p.put({ parent: { id: dir.id }, name: 'b.txt', body: bytes('b') });
    const moved = await p.move({ id: file.id }, { parent: { id: dir.id }, name: 'c.txt' });
    expect(moved.id).toBe(file.id);
    expect(moved.parents).toEqual([dir.id]);
    await expect(p.move({ id: file.id }, { name: 'b.txt' })).rejects.toBeInstanceOf(ConflictError);
  });

  it('copies a file with a new id and its hash, and refuses a folder', async () => {
    const p = provider();
    const dir = await p.mkdir({ parent: { id: 'root' }, name: 'dir' });
    const file = await p.put({
      parent: { id: 'root' },
      name: 'a.txt',
      body: bytes('a'),
      sha256: 'abc',
      appProperties: { byosSha256: 'abc' },
    });
    const copy = await p.copy({ id: file.id }, { parent: { id: dir.id } });
    expect(copy.id).not.toBe(file.id);
    expect(copy).toMatchObject({
      name: 'a.txt',
      sha256: 'abc',
      appProperties: { byosSha256: 'abc' },
    });
    await expect(p.copy({ id: dir.id }, { parent: { id: 'root' } })).rejects.toBeInstanceOf(
      ProviderError,
    );
  });
});

describe('fidelity rules', () => {
  it('move needs a parent or a name, and never into its own subtree', async () => {
    const p = provider();
    const outer = await p.mkdir({ parent: { id: 'root' }, name: 'outer' });
    const inner = await p.mkdir({ parent: { id: outer.id }, name: 'inner' });
    await expect(p.move({ id: outer.id }, {})).rejects.toBeInstanceOf(ProviderError);
    await expect(p.move({ id: outer.id }, { parent: { id: inner.id } })).rejects.toBeInstanceOf(
      ProviderError,
    );
  });

  it('put with overwrite does not replace a folder', async () => {
    const p = provider();
    await p.mkdir({ parent: { id: 'root' }, name: 'dir' });
    await expect(
      p.put({ parent: { id: 'root' }, name: 'dir', body: bytes('x'), overwrite: true }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('a trashed file can still be deleted for good', async () => {
    const p = provider();
    const file = await p.put({ parent: { id: 'root' }, name: 'a.txt', body: bytes('a') });
    await p.delete({ id: file.id });
    await p.delete({ id: file.id }, { permanent: true });
    expect(p.snapshot()).toEqual([]);
  });

  it('the root cannot be deleted', async () => {
    await expect(provider().delete({ id: 'root' })).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('delete', () => {
  it('trashes by default and removes for good with permanent', async () => {
    const p = provider();
    const dir = await p.mkdir({ parent: { id: 'root' }, name: 'dir' });
    const file = await p.put({ parent: { id: dir.id }, name: 'a.txt', body: bytes('a') });
    await p.delete({ id: file.id });
    expect(await p.stat({ id: file.id })).toBeUndefined();
    expect((await p.list({ parent: { id: dir.id } })).items).toEqual([]);
    expect(p.snapshot().find((entry) => entry.id === file.id)?.trashed).toBe(true);
    await p.delete({ id: dir.id }, { permanent: true });
    expect(p.snapshot()).toEqual([]);
  });
});

describe('path resolution', () => {
  it('refuses to pick between two items with the same name', async () => {
    const p = new MemoryProvider({ allowDuplicateNames: true });
    const dir = await p.mkdir({ parent: { id: 'root' }, name: 'dir' });
    await p.put({ parent: { id: dir.id }, name: 'a.txt', body: bytes('1') });
    await p.put({ parent: { id: dir.id }, name: 'a.txt', body: bytes('2') });
    await expect(p.stat({ path: 'dir/a.txt' })).rejects.toBeInstanceOf(ConflictError);
    expect((await p.list({ parent: { path: 'dir' } })).items).toHaveLength(2);
  });

  it('refuses duplicates by default', async () => {
    const p = provider();
    await p.put({ parent: { id: 'root' }, name: 'a.txt', body: bytes('1') });
    await expect(
      p.put({ parent: { id: 'root' }, name: 'a.txt', body: bytes('2') }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('test helpers', () => {
  it('failNext throws once, and calls counts every call', async () => {
    const p = provider();
    const full = new QuotaExceededError('full');
    p.failNext('put', full);
    await expect(p.put({ parent: { id: 'root' }, name: 'a', body: bytes('a') })).rejects.toBe(full);
    await expect(
      p.put({ parent: { id: 'root' }, name: 'a', body: bytes('a') }),
    ).resolves.toMatchObject({ name: 'a' });
    expect(p.calls.put).toBe(2);
    expect(p.calls.delete).toBe(0);
  });
});
