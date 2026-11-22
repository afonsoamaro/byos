import {
  ProviderError,
  type ByosEvents,
  type CopyOptions,
  type DeleteOptions,
  type FileRef,
  type FileStat,
  type ListOptions,
  type ListResult,
  type MkdirOptions,
  type MoveOptions,
  type PutBody,
  type PutOptions,
  type ResumableSession,
  type StorageProvider,
} from '@byos/core';
import { MemoryProvider } from '@byos/core/testing';
import type { ResumeUploadOptions } from '@byos/drive';

const CHUNK = 256 * 1024;

async function read(body: PutBody): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  const chunks: Uint8Array[] = [];
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

interface Open {
  readonly options: PutOptions;
  /** The bytes Drive has confirmed so far. */
  received: Uint8Array;
}

export interface ResumableMemoryOptions {
  /** Puts above this many bytes go through a simulated resumable session. Default 1 MiB. */
  readonly threshold?: number;
  readonly events?: ByosEvents;
}

/**
 * A `MemoryProvider` that also behaves like Drive's resumable upload: big puts report a session
 * per 256 KiB chunk, can be killed part way, and can be resumed by session. It lives in the CLI
 * tests because the CLI must not depend on the drive package's own fake.
 */
export class ResumableMemory implements StorageProvider {
  readonly name = 'resumable-memory';
  readonly inner: MemoryProvider;
  /** Calls the code under test made on this provider, `delete` included. */
  readonly calls = { delete: 0, put: 0, resumeUpload: 0 };
  /** The offsets `resumeUpload` was called with. */
  readonly resumedFrom: number[] = [];
  /** How many puts were running at once, at most. */
  maxInFlight = 0;
  /** Throw (a simulated kill) after this many chunks of the next resumable put. */
  killAfterChunks: number | undefined;
  /** Every resume answers as if the session expired. */
  expireSessions = false;
  /** Report this hash for the next completed upload instead of the real one. */
  nextSha256: string | undefined;
  /** Waits here at the start of every put; lets a test hold uploads in flight. */
  gate: (() => Promise<void>) | undefined;
  /** Waits here after every chunk of a resumable put; lets a test stop one mid-way. */
  chunkGate: (() => Promise<void>) | undefined;

  readonly #threshold: number;
  readonly #events: ByosEvents | undefined;
  readonly #sessions = new Map<string, Open>();
  #inFlight = 0;
  #next = 1;

  constructor(options: ResumableMemoryOptions = {}) {
    this.inner = new MemoryProvider();
    this.#threshold = options.threshold ?? 1024 * 1024;
    this.#events = options.events;
  }

  list(options: ListOptions): Promise<ListResult> {
    return this.inner.list(options);
  }

  stat(ref: FileRef): Promise<FileStat | undefined> {
    return this.inner.stat(ref);
  }

  get(ref: FileRef): Promise<ReadableStream<Uint8Array>> {
    return this.inner.get(ref);
  }

  mkdir(options: MkdirOptions): Promise<FileStat> {
    return this.inner.mkdir(options);
  }

  move(ref: FileRef, options: MoveOptions): Promise<FileStat> {
    return this.inner.move(ref, options);
  }

  copy(ref: FileRef, options: CopyOptions): Promise<FileStat> {
    return this.inner.copy(ref, options);
  }

  delete(ref: FileRef, options?: DeleteOptions): Promise<void> {
    this.calls.delete += 1;
    return this.inner.delete(ref, options);
  }

  async put(options: PutOptions): Promise<FileStat> {
    this.calls.put += 1;
    this.#inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.#inFlight);
    try {
      await this.gate?.();
      const bytes = await read(options.body);
      if (bytes.length <= this.#threshold) return await this.#finish(options, bytes);
      const uri = `mem://s${String(this.#next++)}`;
      const open: Open = { options, received: new Uint8Array(0) };
      this.#sessions.set(uri, open);
      await options.onResumableSession?.({ uri, offset: 0, size: bytes.length });
      return await this.#drain(uri, open, bytes);
    } finally {
      this.#inFlight -= 1;
    }
  }

  async resumeUpload(options: ResumeUploadOptions): Promise<FileStat> {
    this.calls.resumeUpload += 1;
    const open = this.#sessions.get(options.session.uri);
    if (this.expireSessions || !open) {
      throw new ProviderError('the upload session expired; start the upload again', {
        code: 'UPLOAD_SESSION_EXPIRED',
      });
    }
    // Drive says where it is: the confirmed bytes, which can be behind what the client sent.
    const offset = open.received.length;
    this.resumedFrom.push(offset);
    const rest = await read(await options.openAt(offset));
    const bytes = Buffer.concat([open.received, rest]);
    return this.#drain(options.session.uri, open, bytes, options.onResumableSession);
  }

  /** Receives `bytes` chunk by chunk from where the session stands, as Drive would. */
  async #drain(
    uri: string,
    open: Open,
    bytes: Uint8Array,
    onSession: PutOptions['onResumableSession'] = open.options.onResumableSession,
  ): Promise<FileStat> {
    let chunks = 0;
    while (open.received.length < bytes.length) {
      const end = Math.min(open.received.length + CHUNK, bytes.length);
      open.received = bytes.slice(0, end);
      chunks += 1;
      const session: ResumableSession = { uri, offset: end, size: bytes.length };
      await onSession?.(session);
      this.#events?.onUploadProgress?.({
        name: open.options.name,
        bytesConfirmed: end,
        totalBytes: bytes.length,
      });
      await this.chunkGate?.();
      if (
        this.killAfterChunks !== undefined &&
        chunks >= this.killAfterChunks &&
        end < bytes.length
      ) {
        this.killAfterChunks = undefined;
        throw new ProviderError('simulated kill', { retryable: false });
      }
    }
    this.#sessions.delete(uri);
    return this.#finish(open.options, bytes);
  }

  async #finish(options: PutOptions, bytes: Uint8Array): Promise<FileStat> {
    const stat = await this.inner.put({ ...options, body: bytes });
    const sha256 = this.nextSha256;
    this.nextSha256 = undefined;
    return sha256 === undefined ? stat : { ...stat, sha256 };
  }
}
