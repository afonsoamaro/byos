import {
  NotFoundError,
  PathResolver,
  ProviderError,
  type ByosEvents,
  type FileRef,
  type FileStat,
  type ListOptions,
  type ListResult,
  type RetryOptions,
  type StorageProvider,
} from '@byos/core';

import { DriveClient } from './api/client.js';
import {
  FILE_FIELDS,
  FOLDER_MIME,
  GOOGLE_APPS_PREFIX,
  driveFileSchema,
  filesUrl,
  listResponseSchema,
  toFileStat,
} from './api/files.js';
import { childByNameQuery, childrenQuery } from './api/query.js';
import type { TokenManager } from './oauth/token-manager.js';

export interface DriveProviderOptions {
  /** Hands out access tokens; built by the consumer with its TokenStore and key. */
  readonly tokens: TokenManager;
  readonly fetch?: typeof fetch;
  readonly events?: ByosEvents;
  /** Folder id paths are relative to. Default `root` (My Drive). */
  readonly root?: string;
  readonly retry?: RetryOptions;
  /** Bound of the path cache. Default 10,000 entries. */
  readonly cacheEntries?: number;
}

const notImplemented = (operation: string) =>
  Promise.reject(new ProviderError(`${operation} is not implemented yet`));

/** `StorageProvider` over the Google Drive REST API v3, personal Drive only. */
export class DriveProvider implements StorageProvider {
  readonly name = 'google-drive';
  readonly #client: DriveClient;
  readonly #resolver: PathResolver;

  constructor(options: DriveProviderOptions) {
    this.#client = new DriveClient({
      tokens: options.tokens,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.events === undefined ? {} : { events: options.events }),
      ...(options.retry === undefined ? {} : { retry: options.retry }),
    });
    this.#resolver = new PathResolver(this, {
      root: options.root ?? 'root',
      ...(options.cacheEntries === undefined ? {} : { maxEntries: options.cacheEntries }),
      findChildren: (parentId, name) => this.#findChildren(parentId, name),
    });
  }

  list(options: ListOptions): Promise<ListResult> {
    return this.#withRef(options.parent, async (id) => {
      // Drive answers an empty list for a parent that doesn't exist, so check it on the first
      // page; later pages come from a token Drive issued for that same listing.
      if (options.pageToken === undefined) {
        const parent = await this.#statById(id);
        if (!parent) throw new NotFoundError('folder not found in Google Drive');
        if (!parent.isFolder) throw new ProviderError(`${parent.name} is not a folder`);
      }
      const page = await this.#client.json(
        'drive.list',
        filesUrl(undefined, {
          q: childrenQuery(id),
          fields: `nextPageToken,files(${FILE_FIELDS})`,
          pageSize: String(Math.min(Math.max(Math.trunc(options.pageSize ?? 100), 1), 1000)),
          orderBy: 'folder,name_natural',
          ...(options.pageToken === undefined ? {} : { pageToken: options.pageToken }),
        }),
        listResponseSchema,
      );
      const items = page.files.map(toFileStat);
      return page.nextPageToken === undefined
        ? { items }
        : { items, nextPageToken: page.nextPageToken };
    });
  }

  /** Resolves to `undefined` when the file does not exist or is in the trash. */
  async stat(ref: FileRef): Promise<FileStat | undefined> {
    try {
      return await this.#withRef(ref, async (id) => {
        const stat = await this.#statById(id);
        // Throwing lets a path lookup drop a stale cached id and resolve once more.
        if (!stat) throw new NotFoundError('not found in Google Drive');
        return stat;
      });
    } catch (error) {
      if (error instanceof NotFoundError) return undefined;
      throw error;
    }
  }

  get(ref: FileRef): Promise<ReadableStream<Uint8Array>> {
    return this.#withRef(ref, async (id) => {
      const file = await this.#client.json(
        'drive.get',
        filesUrl(id, { fields: 'id,name,mimeType,trashed' }),
        driveFileSchema,
      );
      if (file.trashed) throw new NotFoundError('not found in Google Drive');
      if (file.mimeType === FOLDER_MIME) throw new ProviderError(`${file.name} is a folder`);
      if (file.mimeType.startsWith(GOOGLE_APPS_PREFIX)) {
        throw new ProviderError(
          'Google Docs, Sheets and Slides files cannot be downloaded in v1 (export is not supported)',
        );
      }
      return this.#client.stream('drive.get', filesUrl(id, { alt: 'media' }));
    });
  }

  put(): Promise<FileStat> {
    return notImplemented('put');
  }

  mkdir(): Promise<FileStat> {
    return notImplemented('mkdir');
  }

  move(): Promise<FileStat> {
    return notImplemented('move');
  }

  copy(): Promise<FileStat> {
    return notImplemented('copy');
  }

  delete(): Promise<void> {
    return notImplemented('delete');
  }

  #withRef<T>(ref: FileRef, fn: (id: string) => Promise<T>): Promise<T> {
    return ref.id !== undefined ? fn(ref.id) : this.#resolver.withPath(ref.path, fn);
  }

  async #statById(id: string): Promise<FileStat | undefined> {
    try {
      const file = await this.#client.json(
        'drive.stat',
        filesUrl(id, { fields: FILE_FIELDS }),
        driveFileSchema,
      );
      return file.trashed ? undefined : toFileStat(file);
    } catch (error) {
      if (error instanceof NotFoundError) return undefined;
      throw error;
    }
  }

  async #findChildren(parentId: string, name: string): Promise<FileStat[]> {
    const page = await this.#client.json(
      'drive.lookup',
      filesUrl(undefined, {
        q: childByNameQuery(parentId, name),
        fields: `files(${FILE_FIELDS})`,
        pageSize: '10',
      }),
      listResponseSchema,
    );
    return page.files.map(toFileStat);
  }
}
