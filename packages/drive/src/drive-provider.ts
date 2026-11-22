import {
  ConflictError,
  NotFoundError,
  PathResolver,
  ProviderError,
  normalizePath,
  type ByosEvents,
  type FileRef,
  type FileStat,
  type ListOptions,
  type CopyOptions,
  type DeleteOptions,
  type ListResult,
  type MoveOptions,
  type MkdirOptions,
  type PutOptions,
  type RetryOptions,
  type StorageProvider,
} from '@byos/core';

import { aboutSchema, aboutUrl } from './api/about.js';
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
import { FolderMaker, createWithReconcile, type CreateContext } from './api/creates.js';
import { mimeTypeFor } from './api/mime.js';
import {
  CHUNK_ALIGN,
  DEFAULT_CHUNK_SIZE,
  resumableUpload,
  resumeSession,
  type ResumableContext,
  type ResumeUploadOptions,
} from './api/resumable.js';
import { copy, move, remove, type RelocateContext } from './api/relocate.js';
import { simpleUpload } from './api/simple-upload.js';
import { BYOS_METADATA_VERSION, SIMPLE_UPLOAD_LIMIT, readBody, sha256Hex } from './api/upload.js';
import { childByNameQuery, childrenQuery } from './api/query.js';
import type { TokenManager } from './oauth/token-manager.js';

export interface DriveAccount {
  readonly email: string;
  readonly displayName?: string;
}

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
  /** Resumable upload chunk: a positive multiple of 256 KiB. Default 8 MiB. */
  readonly chunkSize?: number;
}

const fatal = (message: string) => new ProviderError(message, { retryable: false });

/** `StorageProvider` over the Google Drive REST API v3, personal Drive only. */
export class DriveProvider implements StorageProvider {
  readonly name = 'google-drive';
  readonly #client: DriveClient;
  readonly #resolver: PathResolver;
  readonly #root: string;
  readonly #events: ByosEvents | undefined;
  readonly #resumable: ResumableContext;
  readonly #creates: CreateContext;
  readonly #folders: FolderMaker;
  readonly #relocate: RelocateContext;

  constructor(options: DriveProviderOptions) {
    this.#client = new DriveClient({
      tokens: options.tokens,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.events === undefined ? {} : { events: options.events }),
      ...(options.retry === undefined ? {} : { retry: options.retry }),
    });
    const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    if (!Number.isInteger(chunkSize) || chunkSize <= 0 || chunkSize % CHUNK_ALIGN !== 0) {
      throw fatal('chunkSize must be a positive multiple of 256 KiB');
    }
    this.#resumable = {
      client: this.#client,
      chunkSize,
      events: options.events,
      retry: options.retry,
    };
    this.#creates = {
      client: this.#client,
      findChildren: (parentId, name) => this.#findChildren(parentId, name),
      events: options.events,
      retry: options.retry,
    };
    this.#folders = new FolderMaker(this.#creates);
    this.#root = options.root ?? 'root';
    this.#relocate = {
      client: this.#client,
      creates: this.#creates,
      root: this.#root,
      withRef: (ref, fn) => this.#withRef(ref, fn),
      statById: (id) => this.#statById(id),
      invalidate: (ref) => {
        if (ref.path !== undefined) this.#resolver.invalidate(ref.path);
      },
    };
    this.#events = options.events;
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

  /**
   * Uploads a file, writing `byosSha256` and `byosVersion`: a multipart upload up to 5 MiB, a
   * resumable session above it (which needs `size` and `sha256`).
   */
  put(options: PutOptions): Promise<FileStat> {
    return this.#withRef(options.parent, async (parentId) => {
      const size =
        options.size ??
        (options.body instanceof Uint8Array
          ? options.body.length
          : options.body instanceof Blob
            ? options.body.size
            : undefined);
      if (size === undefined) throw fatal('the size is required for a stream body');
      const mimeType = options.mimeType ?? mimeTypeFor(options.name);
      const large = size > SIMPLE_UPLOAD_LIMIT;
      if (large && options.sha256 === undefined) {
        throw fatal('sha256 is required for uploads over 5 MiB');
      }
      const bytes = large ? undefined : await readBody(options.body, size);
      const sha256 = bytes ? await sha256Hex(bytes) : (options.sha256 ?? '').toLowerCase();
      if (options.sha256 !== undefined && options.sha256.toLowerCase() !== sha256) {
        throw fatal('the sha256 passed to put does not match the body');
      }
      const appProperties = {
        ...options.appProperties,
        byosSha256: sha256,
        byosVersion: BYOS_METADATA_VERSION,
      };

      const [existing, ...others] = await this.#findChildren(parentId, options.name);
      if (others.length > 0) throw new ConflictError(`more than one item named ${options.name}`);
      if (existing?.isFolder) throw new ConflictError(`${options.name} is a folder`);
      if (existing && !options.overwrite) throw new ConflictError(`${options.name} already exists`);

      if (!bytes) {
        return resumableUpload(this.#resumable, {
          ...(existing ? { existingId: existing.id } : {}),
          metadata: existing
            ? { mimeType, appProperties }
            : { name: options.name, parents: [parentId], mimeType, appProperties },
          mimeType,
          name: options.name,
          size,
          sha256,
          body: options.body,
          ...(options.onResumableSession ? { onResumableSession: options.onResumableSession } : {}),
        });
      }
      const upload = { parentId, name: options.name, bytes, mimeType, appProperties };
      const stat = existing
        ? await simpleUpload(this.#client, { ...upload, existingId: existing.id })
        : await createWithReconcile(
            this.#creates,
            'drive.put',
            parentId,
            options.name,
            () => simpleUpload(this.#client, upload),
            (found) => !found.isFolder && found.sha256 === sha256,
          );
      this.#events?.onUploadProgress?.({
        name: options.name,
        bytesConfirmed: bytes.length,
        totalBytes: bytes.length,
      });
      return stat;
    });
  }

  /** The signed-in Google account, from `about.get` (no extra scope needed). */
  async account(): Promise<DriveAccount> {
    const { user } = await this.#client.json('drive.about', aboutUrl(), aboutSchema);
    return {
      email: user.emailAddress,
      ...(user.displayName === undefined ? {} : { displayName: user.displayName }),
    };
  }

  /** Continues a resumable upload from the offset Drive confirmed, even in a new process. */
  resumeUpload(options: ResumeUploadOptions): Promise<FileStat> {
    return resumeSession(this.#resumable, options);
  }

  /** Idempotent: returns the existing folder; `parents` creates missing segments of a path. */
  async mkdir(options: MkdirOptions): Promise<FileStat> {
    if (options.parents && options.parent.path !== undefined) {
      let parentId = this.#root;
      for (const segment of normalizePath(options.parent.path)) {
        parentId = (await this.#folders.ensure(parentId, segment)).id;
      }
      return this.#folders.ensure(parentId, options.name);
    }
    return this.#withRef(options.parent, (parentId) =>
      this.#folders.ensure(parentId, options.name),
    );
  }

  move(ref: FileRef, options: MoveOptions): Promise<FileStat> {
    return move(this.#relocate, ref, options);
  }

  copy(ref: FileRef, options: CopyOptions): Promise<FileStat> {
    return copy(this.#relocate, ref, options);
  }

  delete(ref: FileRef, options?: DeleteOptions): Promise<void> {
    return remove(this.#relocate, ref, options);
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
