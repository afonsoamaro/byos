import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { NotFoundError } from '@byos/core';
import { MemoryProvider } from '@byos/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pathApi, safeLocalName } from '../src/local.js';
import { main } from '../src/main.js';
import { cleanup, harness, type Harness } from './helpers.js';

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('real fetch called');
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await cleanup();
});

const sha = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

async function setup() {
  const memory = new MemoryProvider();
  const t = await harness({ memory });
  const work = join(t.dir, 'work');
  await mkdir(work);
  const local = async (name: string, content: string | Uint8Array) => {
    const path = join(work, name);
    await writeFile(path, content);
    return path;
  };
  return { t, memory, work, local };
}

/** The last JSON document a command printed (stdout accumulates across commands). */
const lastJson = (t: Harness) =>
  JSON.parse(t.stdout().trimEnd().split('\n').at(-1) ?? '') as Record<string, unknown>;

describe('put, stat and get', () => {
  it('round-trips a file with a matching SHA-256 and the PP-02 shapes', async () => {
    const { t, work, local } = await setup();
    const file = await local('statement.pdf', 'hello pdf');
    expect(await main(['put', file, '--remote', 'Docs', '--mkdir', '--json'], t.io)).toBe(0);
    const put = lastJson(t);
    expect(Object.keys(put).sort()).toEqual(['id', 'name', 'path', 'sha256', 'size']);
    expect(put).toMatchObject({
      name: 'statement.pdf',
      path: 'Docs/statement.pdf',
      sha256: sha('hello pdf'),
      size: 9,
    });

    expect(await main(['stat', 'Docs/statement.pdf', '--json'], t.io)).toBe(0);
    expect(lastJson(t)).toMatchObject({
      id: put.id,
      kind: 'file',
      sha256: sha('hello pdf'),
      path: 'Docs/statement.pdf',
    });

    const out = join(work, 'copy.pdf');
    expect(await main(['get', 'Docs/statement.pdf', out, '--json'], t.io)).toBe(0);
    expect(sha(await readFile(out))).toBe(sha('hello pdf'));
    expect(lastJson(t)).toMatchObject({ id: put.id, name: 'statement.pdf', size: 9, path: out });
  });

  it('--mkdir creates the nested remote folders', async () => {
    const { t, memory, local } = await setup();
    await main(
      ['put', await local('a.txt', 'x'), '--remote', 'Archive/2026-11', '--mkdir', '--json'],
      t.io,
    );
    expect(lastJson(t).path).toBe('Archive/2026-11/a.txt');
    expect(memory.snapshot().map((e) => e.path)).toEqual([
      'Archive',
      'Archive/2026-11',
      'Archive/2026-11/a.txt',
    ]);
  });

  it('--if-absent twice uploads once and returns the same id', async () => {
    const { t, memory, local } = await setup();
    const file = await local('a.txt', 'same');
    await main(['put', file, '--if-absent', '--json'], t.io);
    const first = lastJson(t);
    expect(await main(['put', file, '--if-absent', '--json'], t.io)).toBe(0);
    expect(lastJson(t).id).toBe(first.id);
    expect(memory.calls.put).toBe(1);
  });

  it('--if-absent with other content is a conflict unless --overwrite is given', async () => {
    const { t, local } = await setup();
    await main(['put', await local('a.txt', 'one'), '--json'], t.io);
    const id = lastJson(t).id;
    const changed = await local('a.txt', 'two!');
    expect(await main(['put', changed, '--if-absent', '--json'], t.io)).toBe(4);
    expect(await main(['put', changed, '--if-absent', '--overwrite', '--json'], t.io)).toBe(0);
    expect(lastJson(t)).toMatchObject({ id, sha256: sha('two!') });
  });

  it('an existing name needs --overwrite, which keeps the id', async () => {
    const { t, local } = await setup();
    const file = await local('a.txt', 'one');
    await main(['put', file, '--json'], t.io);
    const id = lastJson(t).id;
    expect(await main(['put', file, '--json'], t.io)).toBe(4);
    await local('a.txt', 'second');
    expect(await main(['put', file, '--overwrite', '--json'], t.io)).toBe(0);
    expect(lastJson(t).id).toBe(id);
  });

  it('hands a large file to the provider with its size and SHA-256', async () => {
    const { t, memory, local } = await setup();
    const data = new Uint8Array(6 * 1024 * 1024).fill(9);
    const put = vi.spyOn(memory, 'put');
    expect(await main(['put', await local('big.bin', data), '--json'], t.io)).toBe(0);
    expect(put).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'big.bin', size: data.length, sha256: sha(data) }),
    );
  });

  it('--name sets the remote name and --remote can be an id', async () => {
    const { t, memory, local } = await setup();
    const folder = await memory.mkdir({ parent: { path: '' }, name: 'dir' });
    await main(
      [
        'put',
        await local('a.txt', 'x'),
        '--name',
        'renamed.txt',
        '--remote',
        `id:${folder.id}`,
        '--json',
      ],
      t.io,
    );
    expect(lastJson(t)).toMatchObject({ name: 'renamed.txt' });
    expect(await memory.stat({ path: 'dir/renamed.txt' })).toBeDefined();
  });
});

describe('get', () => {
  it('refuses to overwrite a local file without --force, and overwrites with it', async () => {
    const { t, work, local } = await setup();
    await main(['put', await local('a.txt', 'remote'), '--json'], t.io);
    const target = await local('target.txt', 'precious local content');
    expect(await main(['get', 'a.txt', target], t.io)).toBe(4);
    expect(await readFile(target, 'utf8')).toBe('precious local content');
    expect(t.stderr()).toContain('use --force');
    expect(await main(['get', 'a.txt', target, '--force'], t.io)).toBe(0);
    expect(await readFile(target, 'utf8')).toBe('remote');
    expect(await readdir(work)).not.toContain('a.txt.partial');
  });

  it('writes the bytes to stdout without a local path, or with -', async () => {
    const { t, local } = await setup();
    const data = new Uint8Array([0, 255, 10, 13, 65]);
    await main(['put', await local('bin.dat', data), '--json'], t.io);
    expect(await main(['get', 'bin.dat'], t.io)).toBe(0);
    expect([...t.stdoutBytes()]).toEqual([...data]);
    expect(await main(['get', 'bin.dat', '-', '--json'], t.io)).toBe(2);
  });

  it('saves into a folder under the remote name', async () => {
    const { t, work, local } = await setup();
    await main(['put', await local('a.txt', 'x'), '--json'], t.io);
    expect(await main(['get', 'a.txt', work], t.io)).toBe(4);
    const fresh = join(work, 'out');
    await mkdir(fresh);
    expect(await main(['get', 'a.txt', fresh], t.io)).toBe(0);
    expect(await readFile(join(fresh, 'a.txt'), 'utf8')).toBe('x');
  });

  it('never lets a remote name walk out of the target folder', async () => {
    const { t, memory, work } = await setup();
    const folder = join(work, 'dest');
    await mkdir(folder);
    for (const name of ['../escape.txt', '..', '.']) {
      await memory.put({ parent: { path: '' }, name, body: new TextEncoder().encode('x') });
    }
    expect(await main(['get', 'id:mem-1', folder], t.io)).toBe(0);
    expect(await readdir(folder)).toEqual(['.._escape.txt']);
    expect(await readdir(work)).not.toContain('escape.txt');
    for (const id of ['id:mem-2', 'id:mem-3']) {
      expect(await main(['get', id, folder], t.io)).toBe(2);
    }
    expect(await readdir(folder)).toEqual(['.._escape.txt']);
  });
});

describe('safeLocalName', () => {
  it.each([
    ['a.txt', 'linux', 'a.txt'],
    ['../x', 'linux', '.._x'],
    ['a\\b', 'linux', 'a\\b'],
    ['a\\b', 'win32', 'a_b'],
    ['evil:stream', 'win32', 'evil_stream'],
    ['evil:stream', 'linux', 'evil:stream'],
    ['a\u0000b', 'linux', 'a_b'],
    ['CON', 'win32', '_CON'],
    ['nul.txt', 'win32', '_nul.txt'],
    ['report. ', 'win32', 'report'],
    ['CON', 'linux', 'CON'],
    ['..', 'linux', undefined],
    ['.', 'win32', undefined],
    ['', 'linux', undefined],
  ] as const)('%j on %s is %j', (name, platform, expected) => {
    expect(safeLocalName(name, platform)).toBe(expected);
  });

  it('local paths follow the platform: backslashes and spaces on Windows', () => {
    expect(pathApi('win32').basename('C:\\Users\\me\\My Photos\\a b.jpg')).toBe('a b.jpg');
    expect(pathApi('linux').basename('/home/me/My Photos/a b.jpg')).toBe('a b.jpg');
  });
});

describe('ls and stat', () => {
  it('lists every page and prints folders and files', async () => {
    const { t, memory } = await setup();
    const dir = await memory.mkdir({ parent: { path: '' }, name: 'Docs' });
    const a = await memory.put({
      parent: { id: dir.id },
      name: 'a.txt',
      body: new TextEncoder().encode('1'),
    });
    const b = await memory.put({
      parent: { id: dir.id },
      name: 'b.txt',
      body: new TextEncoder().encode('22'),
    });
    const real = memory.list.bind(memory);
    const list = vi
      .spyOn(memory, 'list')
      .mockImplementation((options) =>
        Promise.resolve(
          options.pageToken === undefined ? { items: [a], nextPageToken: 'next' } : { items: [b] },
        ),
      );
    expect(await main(['ls', 'Docs', '--json'], t.io)).toBe(0);
    const items = JSON.parse(t.stdout()) as { name: string; path: string; kind: string }[];
    expect(items.map((i) => i.path)).toEqual(['Docs/a.txt', 'Docs/b.txt']);
    expect(list).toHaveBeenCalledTimes(2);
    list.mockImplementation(real);
    expect(await main(['ls'], t.io)).toBe(0);
    expect(t.stdout()).toContain('Docs/');
  });

  it('id: references work for stat, get and rm', async () => {
    const { t, memory, local } = await setup();
    await main(['put', await local('a.txt', 'x'), '--json'], t.io);
    const id = lastJson(t).id as string;
    expect(await main(['stat', `id:${id}`, '--json'], t.io)).toBe(0);
    expect(lastJson(t)).toMatchObject({ id, name: 'a.txt' });
    expect(lastJson(t)).not.toHaveProperty('path');
    expect(await main(['rm', `id:${id}`, '--json'], t.io)).toBe(0);
    expect(lastJson(t)).toEqual({ id, trashed: true });
    expect(await memory.stat({ id })).toBeUndefined();
  });
});

describe('mkdir, mv, cp and rm', () => {
  it('mkdir is idempotent and --parents creates the path', async () => {
    const { t, memory } = await setup();
    expect(await main(['mkdir', 'A/B', '--parents', '--json'], t.io)).toBe(0);
    const first = lastJson(t);
    await main(['mkdir', 'A/B', '--parents', '--json'], t.io);
    expect(lastJson(t).id).toBe(first.id);
    expect(memory.snapshot().map((e) => e.path)).toEqual(['A', 'A/B']);
    expect(await main(['mkdir', 'X/Y'], t.io)).toBe(3);
  });

  it('mv renames, moves into a folder with a trailing /, and refuses a clash', async () => {
    const { t, memory, local } = await setup();
    await memory.mkdir({ parent: { path: '' }, name: 'dir' });
    await main(['put', await local('a.txt', '1'), '--json'], t.io);
    const id = lastJson(t).id;
    await main(['put', await local('b.txt', '2'), '--json'], t.io);
    expect(await main(['mv', 'a.txt', 'c.txt', '--json'], t.io)).toBe(0);
    expect(lastJson(t)).toMatchObject({ id, name: 'c.txt', path: 'c.txt' });
    expect(await main(['mv', 'c.txt', 'dir/', '--json'], t.io)).toBe(0);
    expect(lastJson(t)).toMatchObject({ id, path: 'dir/c.txt' });
    expect(await main(['mv', 'b.txt', 'dir/c.txt'], t.io)).toBe(4);
  });

  it('cp makes a new file with the same hash, and refuses a folder', async () => {
    const { t, memory, local } = await setup();
    await memory.mkdir({ parent: { path: '' }, name: 'dir' });
    await main(['put', await local('a.txt', 'same'), '--json'], t.io);
    const original = lastJson(t);
    expect(await main(['cp', 'a.txt', 'dir/', '--json'], t.io)).toBe(0);
    const copy = lastJson(t);
    expect(copy.id).not.toBe(original.id);
    expect(copy.sha256).toBe(original.sha256);
    expect(await main(['cp', 'dir', 'other'], t.io)).toBe(1);
  });

  it('rm trashes by default and --permanent removes for good', async () => {
    const { t, memory, local } = await setup();
    await main(['put', await local('a.txt', '1'), '--json'], t.io);
    expect(await main(['rm', 'a.txt', '--json'], t.io)).toBe(0);
    expect(memory.snapshot()).toEqual([expect.objectContaining({ path: 'a.txt', trashed: true })]);
    await main(['put', await local('b.txt', '2'), '--json'], t.io);
    expect(await main(['rm', 'b.txt', '--permanent', '--json'], t.io)).toBe(0);
    expect(lastJson(t)).toMatchObject({ trashed: false });
    expect(memory.snapshot().map((e) => e.path)).toEqual(['a.txt']);
  });

  it('never calls delete for any other command', async () => {
    const { t, memory, local } = await setup();
    await main(['put', await local('a.txt', '1'), '--mkdir', '--remote', 'd', '--json'], t.io);
    await main(['mv', 'd/a.txt', 'd/b.txt'], t.io);
    await main(['cp', 'd/b.txt', 'd/c.txt'], t.io);
    await main(['ls', 'd'], t.io);
    await main(['stat', 'd/c.txt'], t.io);
    expect(memory.calls.delete).toBe(0);
  });
});

describe('local disk and name problems', () => {
  it('a missing destination folder is a usage error, not UNEXPECTED', async () => {
    const { t, work, local } = await setup();
    await main(['put', await local('a.txt', 'x'), '--json'], t.io);
    expect(await main(['get', 'a.txt', join(work, 'no-such-dir', 'x'), '--json'], t.io)).toBe(2);
    expect(JSON.parse(t.stderr().trimEnd().split('\n').at(-1) ?? '')).toMatchObject({
      code: 'USAGE',
    });
  });

  it('put refuses a --name with folders or dots', async () => {
    const { t, memory, local } = await setup();
    const file = await local('a.txt', 'x');
    for (const name of ['..', '.', 'a/b', 'a\\b']) {
      expect(await main(['put', file, '--name', name, '--json'], t.io)).toBe(2);
    }
    expect(memory.calls.put).toBe(0);
  });
});

describe('terminal safety of remote names', () => {
  const evil = 'a\u001b[2Jb\u0007.txt';

  it('human output replaces control characters, JSON keeps the real name', async () => {
    const { t, memory } = await setup();
    await memory.put({ parent: { path: '' }, name: evil, body: new TextEncoder().encode('x') });
    expect(await main(['ls'], t.io)).toBe(0);
    expect(t.stdout()).toContain('a?[2Jb?.txt');
    expect(t.stdout()).not.toContain('\u001b');
    expect(await main(['stat', 'id:mem-1'], t.io)).toBe(0);
    expect(t.stdout()).not.toContain('\u001b');
    expect(await main(['ls', '--json'], t.io)).toBe(0);
    const items = JSON.parse(t.stdout().trimEnd().split('\n').at(-1) ?? '') as { name: string }[];
    expect(items[0]?.name).toBe(evil);
  });

  it('an error message with a control character is cleaned too', async () => {
    const { t, memory } = await setup();
    memory.failNext('stat', new NotFoundError(`no file named ${evil}`));
    expect(await main(['stat', 'x'], t.io)).toBe(3);
    expect(t.stderr()).not.toContain('\u001b');
  });
});
