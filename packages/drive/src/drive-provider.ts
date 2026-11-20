import {
  ConflictError,
  NotFoundError,
  PathResolver,
  ProviderError,
  normalizePath,
  retry,
  type ByosEvents,
  type FileRef,
  type FileStat,
  type ListOptions,
  type ListResult,
  type MkdirOptions,
  type PutOptions,
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
  uploadUrl,
} from './api/files.js';
import { mimeTypeFor } from './api/mime.js';
import { BYOS_METADATA_VERSION, buildMultipart, readBody, sha256Hex } from './api/upload.js';
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
  readonly #root: string;
  readonly #events: ByosEvents | undefined;
  readonly #retry: RetryOptions | undefined;
  /** In-flight folder creations by `parentId/name`, so concurrent mkdirs make one folder. */
  readonly #ensuring = new Map<string, Promise<FileStat>>();

  constructor(options: DriveProviderOptions) {
    this.#client = new DriveClient({
      tokens: options.tokens,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.events === undefined ? {} : { events: options.events }),
      ...(options.retry === undefined ? {} : { retry: options.retry }),
    });
    this.#root = options.root ?? 'root';
    this.#events = options.events;
    this.#retry = options.retry;
    this.#resolver = new PathResolver(this, {
      root: this.#root,
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

  /** Simple multipart upload up to 5 MiB, writing `byosSha256` and `byosVersion`. */
  put(options: PutOptions): Promise<FileStat> {
    return this.#withRef(options.parent, async (parentId) => {
      const bytes = await readBody(options.body, options.size);
      const sha256 = await sha256Hex(bytes);
      if (options.sha256 !== undefined && options.sha256.toLowerCase() !== sha256) {
        throw new ProviderError('the sha256 passed to put does not match the body', {
          retryable: false,
        });
      }
      const mimeType = options.mimeType ?? mimeTypeFor(options.name);
      const appProperties = {
        ...options.appProperties,
        byosSha256: sha256,
        byosVersion: BYOS_METADATA_VERSION,
      };

      const [existing, ...others] = await this.#findChildren(parentId, options.name);
      if (others.length > 0) throw new ConflictError(`more than one item named ${options.name}`);
      let stat: FileStat;
      if (existing) {
        if (existing.isFolder) throw new ConflictError(`${options.name} is a folder`);
        if (!options.overwrite) throw new ConflictError(`${options.name} already exists`);
        const { body, contentType } = buildMultipart({ mimeType, appProperties }, bytes, mimeType);
        stat = toFileStat(
          await this.#client.json(
            'drive.put',
            uploadUrl(existing.id, { uploadType: 'multipart', fields: FILE_FIELDS }),
            driveFileSchema,
            { method: 'PATCH', headers: { 'content-type': contentType }, body },
          ),
        );
      } else {
        const { body, contentType } = buildMultipart(
          { name: options.name, parents: [parentId], mimeType, appProperties },
          bytes,
          mimeType,
        );
        stat = await this.#createWithReconcile(
          'drive.put',
          parentId,
          options.name,
          async () =>
            toFileStat(
              await this.#client.jsonOnce(
                'drive.put',
                uploadUrl(undefined, { uploadType: 'multipart', fields: FILE_FIELDS }),
                driveFileSchema,
                { method: 'POST', headers: { 'content-type': contentType }, body },
              ),
            ),
          (found) => !found.isFolder && found.sha256 === sha256,
        );
      }
      this.#events?.onUploadProgress?.({
        name: options.name,
        bytesConfirmed: bytes.length,
        totalBytes: bytes.length,
      });
      return stat;
    });
  }

  /** Idempotent: returns the existing folder; `parents` creates missing segments of a path. */
  async mkdir(options: MkdirOptions): Promise<FileStat> {
    if (options.parents && options.parent.path !== undefined) {
      let parentId = this.#root;
      for (const segment of normalizePath(options.parent.path)) {
        parentId = (await this.#ensureFolder(parentId, segment)).id;
      }
      return this.#ensureFolder(parentId, options.name);
    }
    return this.#withRef(options.parent, (parentId) => this.#ensureFolder(parentId, options.name));
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

  #ensureFolder(parentId: string, name: string): Promise<FileStat> {
    const key = `${parentId}/${name}`;
    let pending = this.#ensuring.get(key);
    if (!pending) {
      pending = this.#findOrCreateFolder(parentId, name).finally(() => {
        this.#ensuring.delete(key);
      });
      this.#ensuring.set(key, pending);
    }
    return pending;
  }

  async #findOrCreateFolder(parentId: string, name: string): Promise<FileStat> {
    const [existing, ...others] = await this.#findChildren(parentId, name);
    if (others.length > 0) throw new ConflictError(`more than one item named ${name}`);
    if (existing) {
      if (!existing.isFolder) throw new ConflictError(`${name} exists and is not a folder`);
      return existing;
    }
    return this.#createWithReconcile(
      'drive.mkdir',
      parentId,
      name,
      async () =>
        toFileStat(
          await this.#client.jsonOnce(
            'drive.mkdir',
            filesUrl(undefined, { fields: FILE_FIELDS }),
            driveFileSchema,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json; charset=UTF-8' },
              body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
            },
          ),
        ),
      (found) => found.isFolder,
    );
  }

  /**
   * Creates are not idempotent: if Drive created the item but the response was lost, a plain
   * retry would make a duplicate. So from the second attempt on, look for it first.
   */
  #createWithReconcile(
    operation: string,
    parentId: string,
    name: string,
    create: () => Promise<FileStat>,
    matches: (found: FileStat) => boolean,
  ): Promise<FileStat> {
    const onRetry = this.#events?.onRetry;
    return retry(
      async (attempt) => {
        if (attempt > 1) {
          const hit = (await this.#findChildren(parentId, name)).find(matches);
          if (hit) return hit;
        }
        return create();
      },
      { operation, ...(onRetry === undefined ? {} : { onRetry }), ...this.#retry },
    );
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
