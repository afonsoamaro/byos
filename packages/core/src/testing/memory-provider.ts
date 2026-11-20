import { ConflictError, NotFoundError, ProviderError } from '../errors.js';
import type { FileStat, ListResult } from '../file-stat.js';
import type {
  CopyOptions,
  DeleteOptions,
  ListOptions,
  MkdirOptions,
  MoveOptions,
  PutBody,
  PutOptions,
  StorageProvider,
} from '../provider.js';
import type { FileRef } from '../refs.js';

type Operation = Exclude<keyof StorageProvider, 'name'>;

interface Entry {
  id: string;
  name: string;
  parent: string | undefined;
  isFolder: boolean;
  bytes: Uint8Array | undefined;
  mimeType: string | undefined;
  sha256: string | undefined;
  appProperties: Record<string, string>;
  createdAt: string;
  modifiedAt: string;
  trashed: boolean;
}

export interface MemoryProviderOptions {
  /** Clock for `createdAt`/`modifiedAt`. Default: the real time, as an ISO string. */
  readonly now?: () => string;
  /**
   * Accept a second item with the same name in a folder on `put` without `overwrite`, as
   * Drive does. Off by default; on, path resolution over the duplicates raises ConflictError.
   */
  readonly allowDuplicateNames?: boolean;
}

export interface SnapshotEntry {
  readonly id: string;
  readonly path: string;
  readonly isFolder: boolean;
  readonly trashed: boolean;
}

const ROOT = 'root';
const OPERATIONS: readonly Operation[] = [
  'list',
  'stat',
  'get',
  'put',
  'mkdir',
  'move',
  'copy',
  'delete',
];

async function readBody(body: PutBody): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body.slice();
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  const chunks: Uint8Array[] = [];
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/**
 * In-memory `StorageProvider` for tests: mirrors the contract (ids first, trash by default,
 * same-name conflicts, duplicate names refused on path resolution) without any I/O.
 */
export class MemoryProvider implements StorageProvider {
  readonly name = 'memory';
  /** Calls per operation, including ones that threw. */
  readonly calls: Record<Operation, number> = Object.fromEntries(
    OPERATIONS.map((op) => [op, 0]),
  ) as Record<Operation, number>;

  readonly #entries = new Map<string, Entry>();
  readonly #failures = new Map<Operation, Error>();
  readonly #now: () => string;
  readonly #allowDuplicateNames: boolean;
  #nextId = 1;

  constructor(options: MemoryProviderOptions = {}) {
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#allowDuplicateNames = options.allowDuplicateNames ?? false;
    const at = this.#now();
    this.#entries.set(ROOT, {
      id: ROOT,
      name: '',
      parent: undefined,
      isFolder: true,
      bytes: undefined,
      mimeType: undefined,
      sha256: undefined,
      appProperties: {},
      createdAt: at,
      modifiedAt: at,
      trashed: false,
    });
  }

  /** The next call of `operation` throws `error`, once. */
  failNext(operation: Operation, error: Error): void {
    this.#failures.set(operation, error);
  }

  /** Every entry with its path, for assertions. The root is left out. */
  snapshot(): SnapshotEntry[] {
    return [...this.#entries.values()]
      .filter((entry) => entry.id !== ROOT)
      .map((entry) => ({
        id: entry.id,
        path: this.#pathOf(entry),
        isFolder: entry.isFolder,
        trashed: entry.trashed,
      }));
  }

  list(options: ListOptions): Promise<ListResult> {
    return this.#run('list', () => {
      const parent = this.#folder(options.parent);
      const children = this.#children(parent.id).sort((a, b) => a.name.localeCompare(b.name));
      const start = options.pageToken === undefined ? 0 : Number(options.pageToken);
      if (!Number.isInteger(start) || start < 0) throw new ProviderError('invalid page token');
      const end = start + (options.pageSize ?? 100);
      const items = children.slice(start, end).map((entry) => this.#stat(entry));
      return end < children.length ? { items, nextPageToken: String(end) } : { items };
    });
  }

  stat(ref: FileRef): Promise<FileStat | undefined> {
    return this.#run('stat', () => {
      try {
        return this.#stat(this.#resolve(ref));
      } catch (error) {
        if (error instanceof NotFoundError) return undefined;
        throw error;
      }
    });
  }

  get(ref: FileRef): Promise<ReadableStream<Uint8Array>> {
    return this.#run('get', () => {
      const entry = this.#resolve(ref);
      if (entry.isFolder || !entry.bytes) throw new ProviderError(`${entry.name} is a folder`);
      const bytes = entry.bytes.slice();
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    });
  }

  put(options: PutOptions): Promise<FileStat> {
    return this.#run('put', async () => {
      const parent = this.#folder(options.parent);
      const bytes = await readBody(options.body);
      const duplicateOk = this.#allowDuplicateNames && !options.overwrite;
      const existing = duplicateOk ? undefined : this.#childNamed(parent.id, options.name);
      const at = this.#now();
      if (existing) {
        if (!options.overwrite || existing.isFolder) {
          throw new ConflictError(`${options.name} already exists`);
        }
        Object.assign(existing, {
          bytes,
          mimeType: options.mimeType ?? existing.mimeType,
          sha256: options.sha256,
          appProperties: { ...existing.appProperties, ...options.appProperties },
          modifiedAt: at,
        });
        return this.#stat(existing);
      }
      return this.#stat(
        this.#add({
          name: options.name,
          parent: parent.id,
          isFolder: false,
          bytes,
          mimeType: options.mimeType,
          sha256: options.sha256,
          appProperties: { ...options.appProperties },
        }),
      );
    });
  }

  mkdir(options: MkdirOptions): Promise<FileStat> {
    return this.#run('mkdir', () => {
      let parent: Entry;
      if (options.parents && options.parent.path !== undefined) {
        parent = this.#entry(ROOT);
        for (const segment of this.#segments(options.parent.path)) {
          parent = this.#ensureFolder(parent, segment);
        }
      } else {
        parent = this.#folder(options.parent);
      }
      return this.#stat(this.#ensureFolder(parent, options.name));
    });
  }

  move(ref: FileRef, options: MoveOptions): Promise<FileStat> {
    return this.#run('move', () => {
      if (options.parent === undefined && options.name === undefined) {
        throw new ProviderError('move needs a new parent, a new name, or both');
      }
      const entry = this.#resolve(ref);
      const parentId = options.parent ? this.#folder(options.parent).id : entry.parent;
      if (parentId !== undefined && this.#subtree(entry.id).includes(parentId)) {
        throw new ProviderError('a folder cannot be moved into itself');
      }
      const name = options.name ?? entry.name;
      const clash = parentId === undefined ? undefined : this.#childNamed(parentId, name);
      if (clash && clash.id !== entry.id) throw new ConflictError(`${name} already exists`);
      Object.assign(entry, { parent: parentId, name, modifiedAt: this.#now() });
      return this.#stat(entry);
    });
  }

  copy(ref: FileRef, options: CopyOptions): Promise<FileStat> {
    return this.#run('copy', () => {
      const entry = this.#resolve(ref);
      if (entry.isFolder) throw new ProviderError('folders cannot be copied');
      const parent = this.#folder(options.parent);
      const name = options.name ?? entry.name;
      if (this.#childNamed(parent.id, name)) throw new ConflictError(`${name} already exists`);
      return this.#stat(
        this.#add({
          name,
          parent: parent.id,
          isFolder: false,
          bytes: entry.bytes?.slice(),
          mimeType: entry.mimeType,
          sha256: entry.sha256,
          appProperties: { ...entry.appProperties },
        }),
      );
    });
  }

  delete(ref: FileRef, options: DeleteOptions = {}): Promise<void> {
    return this.#run('delete', () => {
      // A trashed item can still be deleted for good by id, as in Drive.
      const trashed = ref.id === undefined ? undefined : this.#entries.get(ref.id);
      const entry = options.permanent && trashed?.trashed ? trashed : this.#resolve(ref);
      if (entry.id === ROOT) throw new ProviderError('the root cannot be deleted');
      if (!options.permanent) {
        entry.trashed = true;
        return;
      }
      for (const id of this.#subtree(entry.id)) this.#entries.delete(id);
    });
  }

  // ── internals ────────────────────────────────────────────────────────────

  async #run<T>(operation: Operation, body: () => T | Promise<T>): Promise<T> {
    this.calls[operation] += 1;
    const failure = this.#failures.get(operation);
    if (failure) {
      this.#failures.delete(operation);
      throw failure;
    }
    return body();
  }

  #add(fields: Omit<Entry, 'id' | 'createdAt' | 'modifiedAt' | 'trashed'>): Entry {
    const at = this.#now();
    const entry: Entry = {
      ...fields,
      id: `mem-${String(this.#nextId++)}`,
      createdAt: at,
      modifiedAt: at,
      trashed: false,
    };
    this.#entries.set(entry.id, entry);
    return entry;
  }

  #entry(id: string): Entry {
    const entry = this.#entries.get(id);
    if (!entry || entry.trashed) throw new NotFoundError(`no file with id ${id}`);
    return entry;
  }

  #segments(path: string): string[] {
    const segments = path.split('/').filter((segment) => segment !== '');
    if (segments.some((segment) => segment === '.' || segment === '..')) {
      throw new ProviderError(`invalid path ${path}`);
    }
    return segments;
  }

  #children(parentId: string): Entry[] {
    return [...this.#entries.values()].filter(
      (entry) => entry.parent === parentId && !entry.trashed,
    );
  }

  #childNamed(parentId: string, name: string): Entry | undefined {
    const matches = this.#children(parentId).filter((entry) => entry.name === name);
    if (matches.length > 1) throw new ConflictError(`more than one item named ${name}`);
    return matches[0];
  }

  #resolve(ref: FileRef): Entry {
    if (ref.id !== undefined) return this.#entry(ref.id);
    let current = this.#entry(ROOT);
    for (const segment of this.#segments(ref.path)) {
      const next = this.#childNamed(current.id, segment);
      if (!next) throw new NotFoundError(`no file at ${ref.path}`);
      current = next;
    }
    return current;
  }

  #folder(ref: FileRef): Entry {
    const entry = this.#resolve(ref);
    if (!entry.isFolder) throw new ProviderError(`${entry.name} is not a folder`);
    return entry;
  }

  #ensureFolder(parent: Entry, name: string): Entry {
    const existing = this.#childNamed(parent.id, name);
    if (existing) {
      if (!existing.isFolder) throw new ConflictError(`${name} exists and is not a folder`);
      return existing;
    }
    return this.#add({
      name,
      parent: parent.id,
      isFolder: true,
      bytes: undefined,
      mimeType: undefined,
      sha256: undefined,
      appProperties: {},
    });
  }

  #subtree(id: string): string[] {
    const ids = [id];
    for (const entry of this.#entries.values()) {
      if (entry.parent === id) ids.push(...this.#subtree(entry.id));
    }
    return ids;
  }

  #pathOf(entry: Entry): string {
    const names: string[] = [];
    let current: Entry | undefined = entry;
    while (current && current.id !== ROOT) {
      names.unshift(current.name);
      current = current.parent === undefined ? undefined : this.#entries.get(current.parent);
    }
    return names.join('/');
  }

  #stat(entry: Entry): FileStat {
    return {
      id: entry.id,
      name: entry.name,
      parents: entry.parent === undefined ? [] : [entry.parent],
      isFolder: entry.isFolder,
      ...(entry.bytes === undefined ? {} : { size: entry.bytes.length }),
      ...(entry.mimeType === undefined ? {} : { mimeType: entry.mimeType }),
      ...(entry.sha256 === undefined ? {} : { sha256: entry.sha256 }),
      modifiedAt: entry.modifiedAt,
      createdAt: entry.createdAt,
      appProperties: { ...entry.appProperties },
    };
  }
}
