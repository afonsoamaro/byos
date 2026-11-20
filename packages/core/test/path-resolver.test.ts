import { describe, expect, it, vi } from 'vitest';

import {
  ConflictError,
  NotFoundError,
  PathResolver,
  ProviderError,
  normalizePath,
  type FileStat,
} from '../src/index.js';
import { MemoryProvider } from '../src/testing/index.js';

const bytes = (text: string) => new TextEncoder().encode(text);

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

/** Writes a file at `path`, creating its folders. */
async function write(p: MemoryProvider, path: string, content = 'x'): Promise<FileStat> {
  const segments = path.split('/');
  const name = segments.pop() ?? '';
  const parent =
    segments.length === 0
      ? { id: 'root' }
      : {
          id: (
            await p.mkdir({
              parent: { path: segments.slice(0, -1).join('/') },
              name: segments.at(-1) ?? '',
              parents: true,
            })
          ).id,
        };
  return p.put({ parent, name, body: bytes(content) });
}

function setup(options: { maxEntries?: number } = {}) {
  const provider = new MemoryProvider();
  const resolver = new PathResolver(provider, { root: 'root', ...options });
  return { provider, resolver };
}

describe('resolve', () => {
  it('walks a 5-level path once, then answers from the cache', async () => {
    const { provider, resolver } = setup();
    const file = await write(provider, 'BYOS Backup/pc/Pictures/2024/a.jpg');
    const before = provider.calls.list;
    expect(await resolver.resolve('BYOS Backup/pc/Pictures/2024/a.jpg')).toBe(file.id);
    expect(provider.calls.list - before).toBe(5);
    expect(await resolver.resolve('BYOS Backup/pc/Pictures/2024/a.jpg')).toBe(file.id);
    expect(provider.calls.list - before).toBe(5);
  });

  it('resolves the empty path to the root without a lookup', async () => {
    const { provider, resolver } = setup();
    for (const path of ['', '/', '//']) expect(await resolver.resolve(path)).toBe('root');
    expect(provider.calls.list).toBe(0);
  });

  it('normalizes slashes and shares the cache entry', async () => {
    const { provider, resolver } = setup();
    const file = await write(provider, 'a/b');
    expect(await resolver.resolve('/a//b/')).toBe(file.id);
    const before = provider.calls.list;
    expect(await resolver.resolve('a/b')).toBe(file.id);
    expect(provider.calls.list).toBe(before);
  });

  it('refuses . and .. before any lookup', async () => {
    const { provider, resolver } = setup();
    await expect(resolver.resolve('a/./b')).rejects.toBeInstanceOf(ProviderError);
    await expect(resolver.resolve('a/../b')).rejects.toBeInstanceOf(ProviderError);
    expect(provider.calls.list).toBe(0);
    expect(normalizePath('/x//y/')).toEqual(['x', 'y']);
  });

  it.each(['Fotos de Família/a.jpg', '🎉 party/b.png', 'notes/10:30 meeting?.txt'])(
    'resolves names with spaces, accents, emoji and Drive-legal characters: %s',
    async (path) => {
      const { provider, resolver } = setup();
      const file = await write(provider, path);
      expect(await resolver.resolve(path)).toBe(file.id);
    },
  );

  it('matches a name stored in NFD from an NFC path', async () => {
    const { provider, resolver } = setup();
    const file = await provider.put({
      parent: { id: 'root' },
      name: 'Família'.normalize('NFD'),
      body: bytes('x'),
    });
    expect(await resolver.resolve('Família'.normalize('NFC'))).toBe(file.id);
  });

  it('names the path up to the missing segment', async () => {
    const { provider, resolver } = setup();
    await write(provider, 'a/b.txt');
    await expect(resolver.resolve('a/missing/deeper/c.txt')).rejects.toThrow(
      new NotFoundError('no file at a/missing'),
    );
  });

  it('refuses to walk through a file', async () => {
    const { provider, resolver } = setup();
    await write(provider, 'a.txt');
    await expect(resolver.resolve('a.txt/b')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('raises ConflictError on duplicate names instead of picking one', async () => {
    const provider = new MemoryProvider({ allowDuplicateNames: true });
    const resolver = new PathResolver(provider, { root: 'root' });
    const dir = await provider.mkdir({ parent: { id: 'root' }, name: 'dir' });
    await provider.put({ parent: { id: dir.id }, name: 'dup.txt', body: bytes('1') });
    await provider.put({ parent: { id: dir.id }, name: 'dup.txt', body: bytes('2') });
    const attempt = resolver.resolve('dir/dup.txt');
    await expect(attempt).rejects.toBeInstanceOf(ConflictError);
    await expect(attempt).rejects.toThrow(/dir\/dup\.txt/);
  });
});

describe('resolveParent', () => {
  it('returns the parent id and the last name without looking it up', async () => {
    const { provider, resolver } = setup();
    const folder = await provider.mkdir({ parent: { path: 'a' }, name: 'b', parents: true });
    expect(await resolver.resolveParent('a/b/c.txt')).toEqual({
      parentId: folder.id,
      name: 'c.txt',
    });
    expect(await resolver.resolveParent('top.txt')).toEqual({ parentId: 'root', name: 'top.txt' });
    await expect(resolver.resolveParent('')).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('stale cache', () => {
  it('withPath drops a cached id that is gone and retries with the new one', async () => {
    const { provider, resolver } = setup();
    const old = await write(provider, 'dir/a.txt', 'old');
    await resolver.resolve('dir/a.txt');
    await provider.delete({ path: 'dir' }, { permanent: true });
    const fresh = await write(provider, 'dir/a.txt', 'new');

    const fn = vi.fn((id: string) => provider.get({ id }).then(readAll));
    expect(await resolver.withPath('dir/a.txt', fn)).toBe('new');
    expect(fn.mock.calls.map(([id]) => id)).toEqual([old.id, fresh.id]);
  });

  it('restarts the walk from the root when a cached parent is gone', async () => {
    const { provider, resolver } = setup();
    await write(provider, 'dir/a.txt');
    await resolver.resolve('dir/a.txt');
    await provider.delete({ path: 'dir' }, { permanent: true });
    const fresh = await write(provider, 'dir/b.txt');
    const before = provider.calls.list;
    expect(await resolver.resolve('dir/b.txt')).toBe(fresh.id);
    // One failed lookup under the stale id, then a single walk from the root (2 lookups).
    expect(provider.calls.list - before).toBe(3);
  });

  it('does not retry when the id was not cached', async () => {
    const { provider, resolver } = setup();
    await write(provider, 'a.txt');
    const gone = new NotFoundError('gone');
    const fn = vi.fn(() => Promise.reject(gone));
    await expect(resolver.withPath('a.txt', fn)).rejects.toBe(gone);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('invalidate drops the path and its descendants only', async () => {
    const { provider, resolver } = setup();
    await write(provider, 'dir/x');
    await write(provider, 'dirt');
    await resolver.resolve('dir/x');
    await resolver.resolve('dirt');
    resolver.invalidate('dir');
    const before = provider.calls.list;
    await resolver.resolve('dirt');
    expect(provider.calls.list).toBe(before);
    await resolver.resolve('dir/x');
    expect(provider.calls.list).toBe(before + 2);
  });
});

describe('cache bound', () => {
  it('evicts the least recently used entry', async () => {
    const { provider, resolver } = setup({ maxEntries: 2 });
    for (const name of ['a', 'b', 'c']) await write(provider, name);
    await resolver.resolve('a');
    await resolver.resolve('b');
    await resolver.resolve('a'); // a is now the most recent
    await resolver.resolve('c'); // evicts b
    const before = provider.calls.list;
    await resolver.resolve('a');
    await resolver.resolve('c');
    expect(provider.calls.list).toBe(before);
    await resolver.resolve('b');
    expect(provider.calls.list).toBe(before + 1);
  });
});

describe('default lookup', () => {
  it('follows list pages to find a child past the first page', async () => {
    const provider = new MemoryProvider();
    const dir = await provider.mkdir({ parent: { id: 'root' }, name: 'big' });
    for (let index = 0; index < 1000; index += 1) {
      await provider.put({
        parent: { id: dir.id },
        name: `a${String(index).padStart(4, '0')}`,
        body: bytes('x'),
      });
    }
    const last = await provider.put({ parent: { id: dir.id }, name: 'z-last', body: bytes('x') });
    const resolver = new PathResolver(provider, { root: 'root' });
    const before = provider.calls.list;
    expect(await resolver.resolve('big/z-last')).toBe(last.id);
    // 1 lookup for `big`, 2 pages of 1000 for `z-last`.
    expect(provider.calls.list - before).toBe(3);
  });
});

describe('findChildren', () => {
  it('uses the injected lookup instead of list', async () => {
    const provider = new MemoryProvider();
    const file = await write(provider, 'a/b.txt');
    const before = provider.calls.list;
    const findChildren = vi.fn(async (parentId: string, name: string) => {
      const stat = await provider.stat({ path: parentId === 'root' ? name : `a/${name}` });
      return stat ? [stat] : [];
    });
    const resolver = new PathResolver(provider, { root: 'root', findChildren });
    expect(await resolver.resolve('a/b.txt')).toBe(file.id);
    expect(findChildren).toHaveBeenCalledTimes(2);
    expect(provider.calls.list).toBe(before);
  });
});
