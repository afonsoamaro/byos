import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { posix } from 'node:path';
import { Readable } from 'node:stream';

import {
  AuthError,
  ByosError,
  ConflictError,
  NotFoundError,
  ProviderError,
  QuotaExceededError,
  type FileStat,
  type PutBody,
  type ResumableSession,
  type StorageProvider,
} from '@byos/core';
import type { ResumeUploadOptions } from '@byos/drive';
import pLimit from 'p-limit';

import type { Manifest } from './manifest.js';
import type { PlanItem } from './plan.js';

/** The Google Drive provider can resume an upload; the contract every provider shares can't. */
export type BackupProvider = StorageProvider & {
  resumeUpload?: (options: ResumeUploadOptions) => Promise<FileStat>;
};

export interface Failure {
  readonly relPath: string;
  readonly code: string;
  readonly message: string;
}

export type StopReason = 'quota' | 'auth' | 'interrupt';

export interface RunResult {
  /** Uploaded and recorded, plus files Drive already held with the same content. */
  readonly uploaded: number;
  readonly failures: readonly Failure[];
  /** Planned files that were not attempted, or did not finish before the run ended. */
  readonly remaining: number;
  /** Resumable uploads cut short whose session is saved for the next run. */
  readonly partial: number;
  readonly stoppedBy?: StopReason;
  /** The error that stopped the run for `quota` or `auth`. */
  readonly stopError?: Error;
}

/** What the executor tells the progress display and the failure log as the run goes. */
export interface UploadObserver {
  started(relPath: string): void;
  finished(relPath: string, size: number): void;
  failed(failure: Failure): void;
}

export interface RunOptions {
  readonly items: readonly PlanItem[];
  readonly manifest: Manifest;
  readonly provider: BackupProvider;
  /** The Drive folder the backup lives in, as path segments: root, device, folder name. */
  readonly base: readonly string[];
  readonly concurrency: number;
  /** Aborted by Ctrl+C: stop starting files and wind the running ones down. */
  readonly signal?: AbortSignal;
  /** How long running uploads get to settle after an interrupt. Default 5 s. */
  readonly graceMs?: number;
  readonly now?: () => number;
  readonly observer?: UploadObserver;
}

/** A failure with a message the user can act on, as opposed to an error from a provider. */
class Refusal extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'Refusal';
    this.code = code;
  }
}

const dirOf = (relPath: string): string => {
  const dir = posix.dirname(relPath);
  return dir === '.' ? '' : dir;
};

const isExpired = (error: unknown): boolean =>
  error instanceof ProviderError && error.code === 'UPLOAD_SESSION_EXPIRED';

/** A code and a message that are safe to show, whatever was thrown. */
export function describe(error: unknown): { code: string; message: string } {
  if (error instanceof Refusal || error instanceof ByosError) {
    return { code: error.code, message: error.message };
  }
  const errno = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof errno === 'string' && /^E[A-Z0-9]+$/.test(errno)) {
    return { code: 'LOCAL_IO', message: `can not be read (${errno})` };
  }
  return {
    code: 'UNEXPECTED',
    message: `unexpected error (${error instanceof Error ? error.name : 'unknown'})`,
  };
}

/**
 * Drive folders for the relative directories of a backup. Ids are cached in the manifest, and
 * concurrent files that need the same missing folder share one creation.
 */
class Folders {
  readonly #manifest: Manifest;
  readonly #provider: BackupProvider;
  readonly #base: readonly string[];
  readonly #pending = new Map<string, Promise<string>>();

  constructor(manifest: Manifest, provider: BackupProvider, base: readonly string[]) {
    this.#manifest = manifest;
    this.#provider = provider;
    this.#base = base;
  }

  resolve(relDir: string): Promise<string> {
    const cached = this.#manifest.folderId(relDir);
    if (cached !== undefined) return Promise.resolve(cached);
    let pending = this.#pending.get(relDir);
    if (!pending) {
      pending = this.#create(relDir).finally(() => {
        this.#pending.delete(relDir);
      });
      this.#pending.set(relDir, pending);
    }
    return pending;
  }

  /** Drops a folder (and what is under it) from the cache: Drive says it is gone. */
  forget(relDir: string): void {
    this.#manifest.clearFolders(relDir);
    for (const key of this.#pending.keys()) {
      if (relDir === '' || key === relDir || key.startsWith(`${relDir}/`))
        this.#pending.delete(key);
    }
  }

  async #create(relDir: string): Promise<string> {
    if (relDir === '') {
      const folder = await this.#provider.mkdir({
        parent: { path: this.#base.slice(0, -1).join('/') },
        name: this.#base.at(-1) ?? '',
        parents: true,
      });
      this.#manifest.setFolderId('', folder.id);
      return folder.id;
    }
    const parentDir = dirOf(relDir);
    const name = posix.basename(relDir);
    let folder: FileStat;
    try {
      folder = await this.#provider.mkdir({ parent: { id: await this.resolve(parentDir) }, name });
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      // The parent was deleted in Drive after it was cached: forget it and build it again.
      this.forget(parentDir);
      folder = await this.#provider.mkdir({ parent: { id: await this.resolve(parentDir) }, name });
    }
    this.#manifest.setFolderId(relDir, folder.id);
    return folder.id;
  }
}

/**
 * Uploads the planned files with bounded concurrency. A file is recorded in the manifest only
 * after Drive confirms it and the content hash matches, so whatever stops the run (an error, a
 * full Drive, Ctrl+C) leaves a manifest the next run can trust. Nothing here deletes anything in
 * Drive, and a file the manifest did not create is never overwritten.
 */
export async function runBackup(options: RunOptions): Promise<RunResult> {
  const { items, manifest, provider, signal } = options;
  const now = options.now ?? Date.now;
  const folders = new Folders(manifest, provider, options.base);
  const limit = pLimit(options.concurrency);
  const failures: Failure[] = [];
  const partial = new Set<string>();
  let uploaded = 0;
  let stoppedBy: StopReason | undefined;
  let stopError: Error | undefined;
  // Set once the run returns: a slow upload that settles later must not touch a closed manifest.
  let ended = false;

  const stopped = (): boolean => stoppedBy !== undefined || signal?.aborted === true;

  const saveSession =
    (item: PlanItem, startedAt: number) =>
    (session: ResumableSession): void => {
      if (ended) return;
      manifest.setSession({
        relPath: item.relPath,
        sessionUri: session.uri,
        offset: session.offset,
        size: session.size,
        sha256: item.sha256,
        startedAt,
      });
      partial.add(item.relPath);
    };

  const openAt =
    (item: PlanItem) =>
    (offset: number): PutBody =>
      Readable.toWeb(
        createReadStream(item.absPath, { start: offset }),
      ) as ReadableStream<Uint8Array>;

  /** The same name is already in Drive and the manifest doesn't know it: adopt only a twin. */
  const adoptTwin = async (parentId: string, item: PlanItem): Promise<FileStat | undefined> => {
    const name = posix.basename(item.relPath);
    let pageToken: string | undefined;
    do {
      const page = await provider.list({
        parent: { id: parentId },
        pageSize: 1000,
        ...(pageToken === undefined ? {} : { pageToken }),
      });
      const twin = page.items.find(
        (found) => found.name === name && !found.isFolder && found.sha256 === item.sha256,
      );
      if (twin) return twin;
      pageToken = page.nextPageToken;
    } while (pageToken !== undefined);
    return undefined;
  };

  /** Continues a saved session; undefined when there is none to use (the caller uploads fresh). */
  const resume = async (item: PlanItem): Promise<FileStat | undefined> => {
    const session = manifest.session(item.relPath);
    if (!session) return undefined;
    if (
      provider.resumeUpload === undefined ||
      session.size !== item.size ||
      session.sha256 !== item.sha256
    ) {
      manifest.clearSession(item.relPath);
      return undefined;
    }
    try {
      return await provider.resumeUpload({
        session: { uri: session.sessionUri, offset: session.offset, size: session.size },
        name: posix.basename(item.relPath),
        sha256: item.sha256,
        openAt: openAt(item),
        onResumableSession: saveSession(item, session.startedAt),
      });
    } catch (error) {
      if (!isExpired(error)) throw error;
      manifest.clearSession(item.relPath);
      partial.delete(item.relPath);
      return undefined;
    }
  };

  const transfer = async (item: PlanItem): Promise<FileStat> => {
    const name = posix.basename(item.relPath);
    // Drive gets the bytes that were planned: a file edited since then waits for the next run.
    const info = await stat(item.absPath);
    if (info.size !== item.size || info.mtimeMs !== item.mtimeMs) {
      throw new Refusal('CHANGED', 'changed while the backup ran; the next run uploads it');
    }
    const parentId = await folders.resolve(dirOf(item.relPath));

    let result = await resume(item);
    if (!result) {
      let overwriteId = item.driveId;
      if (overwriteId !== undefined) {
        // Overwrite only the file this manifest created, still where and as it was left.
        const current = await provider.stat({ id: overwriteId });
        if (current === undefined) overwriteId = undefined;
        else if (current.isFolder || current.name !== name || !current.parents.includes(parentId)) {
          throw new Refusal(
            'REMOTE_CHANGED',
            'the Drive file was moved or renamed; not overwritten',
          );
        }
      }
      try {
        result = await provider.put({
          parent: { id: parentId },
          name,
          body: Readable.toWeb(createReadStream(item.absPath)) as ReadableStream<Uint8Array>,
          size: item.size,
          sha256: item.sha256,
          overwrite: overwriteId !== undefined,
          onResumableSession: saveSession(item, now()),
        });
      } catch (error) {
        if (!(error instanceof ConflictError) || overwriteId !== undefined) throw error;
        result = await adoptTwin(parentId, item);
        if (!result) {
          throw new Refusal(
            'CONFLICT',
            'a different file with this name already exists in Drive; not overwritten',
          );
        }
      }
      if (overwriteId !== undefined && result.id !== overwriteId) {
        throw new Refusal('REMOTE_CHANGED', 'the Drive file changed; not recorded');
      }
    }
    if (result.sha256 !== item.sha256) {
      throw new Refusal('HASH_MISMATCH', 'Drive holds different content; not recorded');
    }
    return result;
  };

  const attempt = async (item: PlanItem): Promise<FileStat> => {
    try {
      return await transfer(item);
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      // A cached folder may have been deleted in Drive: forget it and try once more.
      folders.forget(dirOf(item.relPath));
      return transfer(item);
    }
  };

  const task = async (item: PlanItem): Promise<void> => {
    if (stopped()) return;
    options.observer?.started(item.relPath);
    try {
      const file = await attempt(item);
      if (ended) return;
      manifest.recordUpload(
        item.relPath,
        { size: item.size, mtimeMs: item.mtimeMs, sha256: item.sha256, driveId: file.id },
        now(),
      );
      manifest.clearSession(item.relPath);
      partial.delete(item.relPath);
      uploaded += 1;
      options.observer?.finished(item.relPath, item.size);
    } catch (error) {
      if (error instanceof QuotaExceededError) {
        stoppedBy ??= 'quota';
        stopError ??= error;
      } else if (error instanceof AuthError) {
        stoppedBy ??= 'auth';
        stopError ??= error;
      } else if (!ended) {
        const failure = { relPath: item.relPath, ...describe(error) };
        failures.push(failure);
        options.observer?.failed(failure);
      }
    }
  };

  const all = Promise.allSettled(items.map((item) => limit(() => task(item))));
  if (signal) {
    const aborted = new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else
        signal.addEventListener(
          'abort',
          () => {
            resolve();
          },
          { once: true },
        );
    });
    await Promise.race([all, aborted]);
    if (signal.aborted) {
      stoppedBy ??= 'interrupt';
      let timer: NodeJS.Timeout | undefined;
      const grace = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, options.graceMs ?? 5000);
      });
      await Promise.race([all, grace]);
      clearTimeout(timer);
    }
  } else {
    await all;
  }
  ended = true;

  return {
    uploaded,
    failures,
    remaining: items.length - uploaded - failures.length,
    partial: partial.size,
    ...(stoppedBy === undefined ? {} : { stoppedBy }),
    ...(stopError === undefined ? {} : { stopError }),
  };
}
