import { ConflictError, NotFoundError, ProviderError } from './errors.js';
import type { FileStat } from './file-stat.js';
import type { StorageProvider } from './provider.js';

export interface PathResolverOptions {
  /** Id of the folder paths are relative to (Drive's `root`, or a configured folder id). */
  readonly root: string;
  /** Bound of the path → id cache. Default 10,000 entries. */
  readonly maxEntries?: number;
  /**
   * Children of `parentId` named `name`. Defaults to paging through `provider.list`, which is
   * fine for small folders; a provider with a name query (Drive) should pass its own.
   */
  readonly findChildren?: (parentId: string, name: string) => Promise<readonly FileStat[]>;
}

/**
 * Splits a POSIX path into NFC-normalized segments. Leading, trailing and repeated slashes are
 * dropped; `.` and `..` are refused. No other character is special, as in Drive.
 */
export function normalizePath(path: string): string[] {
  const segments = path.split('/').filter((segment) => segment !== '');
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new ProviderError(`invalid path ${path}: . and .. are not allowed`);
  }
  return segments.map((segment) => segment.normalize('NFC'));
}

/**
 * Turns paths into provider ids by walking folder names from a root, with an LRU cache.
 * Names compare in NFC, so a path typed on one OS matches a name stored from another. When a
 * segment matches more than one item (Drive allows duplicates) it raises ConflictError and
 * never picks one.
 */
export class PathResolver {
  readonly #provider: StorageProvider;
  readonly #root: string;
  readonly #maxEntries: number;
  readonly #findChildren: (parentId: string, name: string) => Promise<readonly FileStat[]>;
  readonly #cache = new Map<string, string>();

  constructor(provider: StorageProvider, options: PathResolverOptions) {
    this.#provider = provider;
    this.#root = options.root;
    this.#maxEntries = options.maxEntries ?? 10_000;
    this.#findChildren =
      options.findChildren ?? ((parentId, name) => this.#listChildren(parentId, name));
  }

  /** Id of the item at `path`; the empty path is the root. */
  async resolve(path: string): Promise<string> {
    return (await this.#locate(normalizePath(path))).id;
  }

  /** Id of the folder that holds `path`, and the last segment, which is not looked up. */
  async resolveParent(path: string): Promise<{ parentId: string; name: string }> {
    const segments = normalizePath(path);
    const name = segments.at(-1);
    if (name === undefined) throw new ProviderError('the root has no parent');
    const parent = await this.#locate(segments.slice(0, -1));
    return { parentId: parent.id, name };
  }

  /**
   * Resolves `path` and runs `fn` with the id. If `fn` throws NotFoundError for an id that came
   * from the cache, the entry and its descendants are dropped and `fn` runs once more with a
   * freshly resolved id.
   */
  async withPath<T>(path: string, fn: (id: string) => Promise<T>): Promise<T> {
    const segments = normalizePath(path);
    const first = await this.#locate(segments);
    try {
      return await fn(first.id);
    } catch (error) {
      if (!(error instanceof NotFoundError) || !first.cached) throw error;
      this.#invalidateKey(segments.join('/'));
      return fn((await this.#locate(segments)).id);
    }
  }

  /** Drops `path` and everything under it from the cache. */
  invalidate(path: string): void {
    this.#invalidateKey(normalizePath(path).join('/'));
  }

  clear(): void {
    this.#cache.clear();
  }

  // ── internals ────────────────────────────────────────────────────────────

  async #locate(segments: readonly string[]): Promise<{ id: string; cached: boolean }> {
    if (segments.length === 0) return { id: this.#root, cached: false };
    const prefix = this.#cachedPrefix(segments);
    if (!prefix) return { id: await this.#walk(this.#root, segments, 0), cached: false };
    if (prefix.length === segments.length) return { id: prefix.id, cached: true };
    try {
      return { id: await this.#walk(prefix.id, segments, prefix.length), cached: false };
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      // The cached folder may be gone or moved: forget it and walk once from the root.
      this.#invalidateKey(segments.slice(0, prefix.length).join('/'));
      return { id: await this.#walk(this.#root, segments, 0), cached: false };
    }
  }

  async #walk(startId: string, segments: readonly string[], from: number): Promise<string> {
    let parentId = startId;
    for (let index = from; index < segments.length; index += 1) {
      const name = segments[index] ?? '';
      const here = segments.slice(0, index + 1).join('/');
      // Filtered again here even for the default lookup: an injected findChildren may match
      // loosely (a name query that ignores Unicode normalization, or a prefix search).
      const matches = (await this.#findChildren(parentId, name)).filter(
        (child) => child.name.normalize('NFC') === name,
      );
      const [match, ...others] = matches;
      if (!match) throw new NotFoundError(`no file at ${here}`);
      if (others.length > 0) throw new ConflictError(`more than one item named ${name} at ${here}`);
      if (index < segments.length - 1 && !match.isFolder) {
        throw new NotFoundError(`no folder at ${here}`);
      }
      this.#cacheSet(here, match.id);
      parentId = match.id;
    }
    return parentId;
  }

  #cachedPrefix(segments: readonly string[]): { length: number; id: string } | undefined {
    for (let length = segments.length; length > 0; length -= 1) {
      const key = segments.slice(0, length).join('/');
      const id = this.#cache.get(key);
      if (id !== undefined) {
        // Refresh recency: a Map iterates in insertion order, so the oldest key comes first.
        this.#cache.delete(key);
        this.#cache.set(key, id);
        return { length, id };
      }
    }
    return undefined;
  }

  #cacheSet(key: string, id: string): void {
    this.#cache.delete(key);
    this.#cache.set(key, id);
    if (this.#cache.size > this.#maxEntries) {
      const oldest = this.#cache.keys().next();
      if (!oldest.done) this.#cache.delete(oldest.value);
    }
  }

  #invalidateKey(key: string): void {
    for (const cached of [...this.#cache.keys()]) {
      if (cached === key || cached.startsWith(`${key}/`)) this.#cache.delete(cached);
    }
  }

  async #listChildren(parentId: string, name: string): Promise<FileStat[]> {
    const found: FileStat[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.#provider.list({
        parent: { id: parentId },
        pageSize: 1000,
        ...(pageToken === undefined ? {} : { pageToken }),
      });
      found.push(...page.items.filter((item) => item.name.normalize('NFC') === name));
      pageToken = page.nextPageToken;
    } while (pageToken !== undefined);
    return found;
  }
}
