import { ConflictError, NotFoundError, ProviderError } from '../errors.js';
import type { StorageProvider } from '../provider.js';

// A contract suite every StorageProvider must pass, written without a test framework and
// without Node built-ins so it ships in `dist` and runs in any runtime. Providers run it from
// their own tests: `for (const c of storageContract()) it(c.name, () => c.run(harness))`.

export interface ContractHarness {
  readonly provider: StorageProvider;
}

export interface ContractCase {
  readonly name: string;
  readonly run: (harness: ContractHarness) => Promise<void>;
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`contract: ${message}`);
}

async function rejectsWith(
  work: Promise<unknown>,
  kind: new (...args: never[]) => Error,
  what: string,
): Promise<void> {
  try {
    await work;
  } catch (error) {
    check(error instanceof kind, `${what}: expected ${kind.name}, got ${String(error)}`);
    return;
  }
  throw new Error(`contract: ${what}: expected ${kind.name}, but it resolved`);
}

const bytes = (text: string) => new TextEncoder().encode(text);
const ROOT = { path: '' } as const;

async function sha256Hex(data: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

async function put(provider: StorageProvider, name: string, text: string, parentId?: string) {
  return provider.put({
    parent: parentId === undefined ? ROOT : { id: parentId },
    name,
    body: bytes(text),
  });
}

export function storageContract(): ContractCase[] {
  return [
    {
      name: 'put then stat round-trips the size, the id and the hash',
      async run({ provider }) {
        const sha256 = await sha256Hex(bytes('hello'));
        const created = await provider.put({
          parent: ROOT,
          name: 'a.txt',
          body: bytes('hello'),
          sha256,
        });
        check(created.size === 5, 'put reports the size');
        const stat = await provider.stat({ id: created.id });
        check(stat?.id === created.id && stat.name === 'a.txt', 'stat finds it by id');
        check(stat?.sha256 === sha256, 'the hash round-trips');
        check((await provider.stat({ path: 'a.txt' }))?.id === created.id, 'stat finds it by path');
      },
    },
    {
      name: 'put on an existing name without overwrite is a ConflictError',
      async run({ provider }) {
        await put(provider, 'a.txt', 'one');
        await rejectsWith(put(provider, 'a.txt', 'two'), ConflictError, 'second put');
      },
    },
    {
      name: 'get returns the bytes',
      async run({ provider }) {
        const created = await put(provider, 'a.txt', 'hello');
        check((await readAll(await provider.get({ id: created.id }))) === 'hello', 'bytes match');
      },
    },
    {
      name: 'list shows children and hides trashed ones',
      async run({ provider }) {
        const kept = await put(provider, 'kept.txt', '1');
        const gone = await put(provider, 'gone.txt', '2');
        await provider.delete({ id: gone.id });
        const names = (await provider.list({ parent: ROOT })).items.map((item) => item.name);
        check(
          names.includes('kept.txt') && !names.includes('gone.txt'),
          `list is ${names.join(',')}`,
        );
        check(kept.id !== gone.id, 'distinct ids');
      },
    },
    {
      name: 'mkdir is idempotent',
      async run({ provider }) {
        const first = await provider.mkdir({ parent: ROOT, name: 'dir' });
        const second = await provider.mkdir({ parent: ROOT, name: 'dir' });
        check(first.isFolder && first.id === second.id, 'same folder id');
      },
    },
    {
      name: 'move renames and keeps the id',
      async run({ provider }) {
        const dir = await provider.mkdir({ parent: ROOT, name: 'dir' });
        const file = await put(provider, 'a.txt', 'x');
        const moved = await provider.move(
          { id: file.id },
          { parent: { id: dir.id }, name: 'b.txt' },
        );
        check(moved.id === file.id && moved.name === 'b.txt', 'id kept, name changed');
        check(moved.parents.includes(dir.id), 'now in the folder');
        check(
          (await provider.stat({ path: 'dir/b.txt' }))?.id === file.id,
          'found at the new path',
        );
      },
    },
    {
      name: 'move onto an existing name is a ConflictError',
      async run({ provider }) {
        const a = await put(provider, 'a.txt', '1');
        await put(provider, 'b.txt', '2');
        await rejectsWith(
          provider.move({ id: a.id }, { name: 'b.txt' }),
          ConflictError,
          'move clash',
        );
      },
    },
    {
      name: 'move to the same parent and name is a no-op',
      async run({ provider }) {
        const a = await put(provider, 'a.txt', '1');
        const same = await provider.move({ id: a.id }, { name: 'a.txt' });
        check(same.id === a.id && same.name === 'a.txt', 'unchanged');
      },
    },
    {
      name: 'move with neither parent nor name is a ProviderError',
      async run({ provider }) {
        const a = await put(provider, 'a.txt', '1');
        await rejectsWith(provider.move({ id: a.id }, {}), ProviderError, 'empty move');
      },
    },
    {
      name: 'copy gives a new id and keeps the hash',
      async run({ provider }) {
        const dir = await provider.mkdir({ parent: ROOT, name: 'dir' });
        const source = await provider.put({
          parent: ROOT,
          name: 'a.txt',
          body: bytes('same'),
          sha256: await sha256Hex(bytes('same')),
        });
        const copy = await provider.copy({ id: source.id }, { parent: { id: dir.id } });
        check(copy.id !== source.id, 'new id');
        check(copy.sha256 === source.sha256 && source.sha256 !== undefined, 'hash kept');
        check((await readAll(await provider.get({ id: copy.id }))) === 'same', 'bytes copied');
      },
    },
    {
      name: 'copy of a folder is a ProviderError',
      async run({ provider }) {
        const dir = await provider.mkdir({ parent: ROOT, name: 'dir' });
        await rejectsWith(
          provider.copy({ id: dir.id }, { parent: ROOT, name: 'dir2' }),
          ProviderError,
          'folder copy',
        );
      },
    },
    {
      name: 'delete hides the file from stat (a trashed file is not found)',
      async run({ provider }) {
        const a = await put(provider, 'a.txt', '1');
        await provider.delete({ id: a.id });
        check(
          (await provider.stat({ id: a.id })) === undefined,
          'stat is undefined after trashing',
        );
      },
    },
    {
      name: 'delete with permanent works on a trashed file',
      async run({ provider }) {
        const a = await put(provider, 'a.txt', '1');
        await provider.delete({ id: a.id });
        await provider.delete({ id: a.id }, { permanent: true });
        check((await provider.stat({ id: a.id })) === undefined, 'gone for good');
      },
    },
    {
      name: 'a missing id is a NotFoundError on get, move, copy and delete',
      async run({ provider }) {
        const missing = { id: 'does-not-exist' };
        await rejectsWith(provider.get(missing), NotFoundError, 'get');
        await rejectsWith(provider.move(missing, { name: 'x' }), NotFoundError, 'move');
        await rejectsWith(provider.copy(missing, { parent: ROOT }), NotFoundError, 'copy');
        await rejectsWith(provider.delete(missing), NotFoundError, 'delete');
      },
    },
  ];
}
