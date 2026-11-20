import type { FileStat, ListResult } from './file-stat.js';
import type { FileRef } from './refs.js';

export type PutBody = ReadableStream<Uint8Array> | Uint8Array | Blob;

/**
 * A resumable upload session as the provider reports it. The `uri` accepts bytes without
 * further auth for a while: persist it like a secret and never log it.
 */
export interface ResumableSession {
  readonly uri: string;
  /** Bytes the provider has confirmed. */
  readonly offset: number;
  readonly size: number;
}

export interface ListOptions {
  readonly parent: FileRef;
  readonly pageSize?: number;
  readonly pageToken?: string;
}

export interface PutOptions {
  readonly parent: FileRef;
  readonly name: string;
  readonly body: PutBody;
  readonly size?: number;
  readonly mimeType?: string;
  /** Lowercase hex SHA-256 of the body, when the caller already has it. */
  readonly sha256?: string;
  /** Replace an existing same-name file with a new revision of it. Default `false`. */
  readonly overwrite?: boolean;
  readonly appProperties?: Readonly<Record<string, string>>;
  /** Called when a resumable session opens or advances, so the consumer can persist it. */
  readonly onResumableSession?: (session: ResumableSession) => void | Promise<void>;
}

export interface MkdirOptions {
  readonly parent: FileRef;
  readonly name: string;
  /** Create missing folders when `parent` is a path. Default `false`. */
  readonly parents?: boolean;
}

export interface MoveOptions {
  readonly parent?: FileRef;
  readonly name?: string;
}

export interface CopyOptions {
  readonly parent: FileRef;
  readonly name?: string;
}

export interface DeleteOptions {
  /** Delete for good instead of moving to the trash. Default `false`. */
  readonly permanent?: boolean;
}

/**
 * What every storage provider implements. IDs first: every result carries the provider id.
 * No sync primitives, by design: no cursors, change feeds or tombstones.
 */
export interface StorageProvider {
  readonly name: string;
  list(options: ListOptions): Promise<ListResult>;
  /** Resolves to `undefined` when the file does not exist or is in the trash. */
  stat(ref: FileRef): Promise<FileStat | undefined>;
  get(ref: FileRef): Promise<ReadableStream<Uint8Array>>;
  put(options: PutOptions): Promise<FileStat>;
  /** Idempotent: returns the existing folder when one with that name is already there. */
  mkdir(options: MkdirOptions): Promise<FileStat>;
  move(ref: FileRef, options: MoveOptions): Promise<FileStat>;
  copy(ref: FileRef, options: CopyOptions): Promise<FileStat>;
  /** Moves to the trash unless `permanent` is set. */
  delete(ref: FileRef, options?: DeleteOptions): Promise<void>;
}
