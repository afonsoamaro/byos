import {
  ProviderError,
  retry,
  type ByosEvents,
  type FileStat,
  type PutBody,
  type ResumableSession,
  type RetryOptions,
} from '@byos/core';

import type { DriveClient } from './client.js';
import { mapDriveError } from './errors.js';
import { FILE_FIELDS, driveFileSchema, toFileStat, uploadUrl } from './files.js';

// Drive's resumable upload: open a session, send chunks with Content-Range, and always
// continue from the offset Drive confirmed (its Range header), never from the bytes sent.
// The session URI accepts bytes without further auth for a while: it goes only to fetch and
// to onResumableSession, never into an error, a hook event or a log.

export const CHUNK_ALIGN = 256 * 1024;
export const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;
/** Rounds in a row without Drive confirming a single new byte before giving up. */
const MAX_STALLS = 3;

export interface ResumableContext {
  readonly client: DriveClient;
  readonly chunkSize: number;
  readonly events?: ByosEvents | undefined;
  readonly retry?: RetryOptions | undefined;
}

type OnSession = (session: ResumableSession) => void | Promise<void>;

export interface ResumableUploadOptions {
  /** Upload a new revision of this file instead of creating one. */
  readonly existingId?: string;
  readonly metadata: Record<string, unknown>;
  readonly mimeType: string;
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
  readonly body: PutBody;
  readonly onResumableSession?: OnSession;
}

export interface ResumeUploadOptions {
  /** As last received through `onResumableSession`. */
  readonly session: ResumableSession;
  readonly name: string;
  readonly sha256: string;
  /** Opens the content at `offset`, the byte Drive confirmed, which may be ahead of `session.offset`. */
  readonly openAt: (offset: number) => PutBody | Promise<PutBody>;
  readonly onResumableSession?: OnSession;
}

type Status =
  | { readonly done: false; readonly offset: number }
  | { readonly done: true; readonly stat: FileStat };

const expired = () =>
  new ProviderError('the upload session expired; start the upload again', {
    code: 'UPLOAD_SESSION_EXPIRED',
  });

const fatal = (message: string) => new ProviderError(message, { retryable: false });

/**
 * A session URI must be Drive's own upload endpoint. It arrives from outside (the `Location`
 * header, and from the consumer's storage on resume), and the bearer token goes with it, so a
 * tampered value must never send the token elsewhere.
 */
export function assertSessionUri(uri: string): void {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw fatal('invalid upload session');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'www.googleapis.com' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    !url.pathname.startsWith('/upload/drive/v3/files') ||
    !url.searchParams.get('upload_id')
  ) {
    throw fatal('invalid upload session');
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/** `Range: bytes=0-<n>` is inclusive, so `n + 1` bytes are confirmed; no header means none. */
export function confirmedFromRange(header: string | null): number {
  if (header === null) return 0;
  const match = /^bytes=0-(\d+)$/.exec(header.trim());
  if (!match) throw fatal('unexpected Range header from Google Drive');
  return Number(match[1]) + 1;
}

async function interpret(response: Response): Promise<Status> {
  if (response.status === 308) {
    return { done: false, offset: confirmedFromRange(response.headers.get('range')) };
  }
  if (response.status === 200 || response.status === 201) {
    const parsed = driveFileSchema.safeParse(await readJson(response));
    if (!parsed.success)
      throw new ProviderError('unexpected response from Google Drive (drive.upload)');
    return { done: true, stat: toFileStat(parsed.data) };
  }
  if (response.status === 404 || response.status === 410) throw expired();
  throw mapDriveError(response.status, await readJson(response), response.headers, Date.now());
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** Slices of at most `chunkSize` bytes, read lazily; each slice is a fresh copy. */
export async function* chunks(
  body: PutBody,
  chunkSize: number,
): AsyncGenerator<Uint8Array<ArrayBuffer>> {
  if (body instanceof Uint8Array) {
    for (let at = 0; at < body.length; at += chunkSize)
      yield new Uint8Array(body.subarray(at, at + chunkSize));
    return;
  }
  if (body instanceof Blob) {
    for (let at = 0; at < body.size; at += chunkSize) {
      yield new Uint8Array(await body.slice(at, at + chunkSize).arrayBuffer());
    }
    return;
  }
  // Keep the reads as they come and join them once per chunk, instead of copying the
  // growing buffer on every read.
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let buffered = 0;
  const take = (length: number): Uint8Array<ArrayBuffer> => {
    const out = new Uint8Array(length);
    let filled = 0;
    while (filled < length) {
      const part = parts[0] as Uint8Array;
      const need = length - filled;
      if (part.length <= need) {
        out.set(part, filled);
        filled += part.length;
        parts.shift();
      } else {
        out.set(part.subarray(0, need), filled);
        parts[0] = part.subarray(need);
        filled += need;
      }
    }
    buffered -= length;
    return out;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    buffered += value.length;
    while (buffered >= chunkSize) yield take(chunkSize);
  }
  if (buffered > 0) yield take(buffered);
}

interface Session {
  readonly ctx: ResumableContext;
  readonly uri: string;
  readonly size: number;
  readonly name: string;
  readonly onSession: OnSession | undefined;
}

function queryStatus(session: Session): Promise<Status> {
  return session.ctx.client
    .rawOnce('drive.upload', session.uri, {
      method: 'PUT',
      headers: { 'content-range': `bytes */${String(session.size)}` },
    })
    .then(interpret);
}

/**
 * Sends `chunk`, which starts at the confirmed offset `start`. On a retry, asks Drive where it
 * stands first and resends only what it hasn't confirmed: this is also what turns a lost final
 * response into a finished upload instead of a second file.
 */
function sendChunk(
  session: Session,
  chunk: Uint8Array<ArrayBuffer>,
  start: number,
): Promise<Status> {
  const { ctx } = session;
  const onRetry = ctx.events?.onRetry;
  return retry(
    async (attempt) => {
      let from = start;
      if (attempt > 1) {
        const status = await queryStatus(session);
        if (status.done) return status;
        if (status.offset < start)
          throw fatal('Google Drive reported an upload offset that went backwards');
        if (status.offset > start + chunk.length) {
          throw fatal('Google Drive confirmed bytes this upload has not sent');
        }
        if (status.offset === start + chunk.length) return status;
        from = status.offset;
      }
      const part = chunk.slice(from - start);
      const end = from + part.length - 1;
      const response = await ctx.client.rawOnce('drive.upload', session.uri, {
        method: 'PUT',
        headers: {
          'content-range': `bytes ${String(from)}-${String(end)}/${String(session.size)}`,
        },
        body: part,
      });
      return interpret(response);
    },
    { operation: 'drive.upload', ...(onRetry === undefined ? {} : { onRetry }), ...ctx.retry },
  );
}

/** Streams `body`, which holds the content from byte `start`, until Drive has all `size` bytes. */
async function run(session: Session, body: PutBody, start: number): Promise<FileStat> {
  const { ctx, size, name } = session;
  const finish = (stat: FileStat) => {
    ctx.events?.onUploadProgress?.({ name, bytesConfirmed: size, totalBytes: size });
    return stat;
  };
  const source = chunks(body, ctx.chunkSize)[Symbol.asyncIterator]();
  let offset = start;
  let read = start;
  let pending: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  let ended = false;
  let stalls = 0;
  for (;;) {
    while (!ended && pending.length < ctx.chunkSize) {
      const next = await source.next();
      if (next.done) {
        ended = true;
        if (read !== size)
          throw fatal(`the content ended at byte ${String(read)} of ${String(size)}`);
      } else {
        read += next.value.length;
        if (read > size) throw fatal(`the content is longer than its size (${String(size)} bytes)`);
        pending = concat(pending, next.value);
      }
    }
    if (pending.length === 0) {
      const status = await queryStatus(session);
      if (status.done) return finish(status.stat);
      throw fatal('Google Drive did not confirm the whole file');
    }
    const status = await sendChunk(
      session,
      pending.slice(0, Math.min(ctx.chunkSize, pending.length)),
      offset,
    );
    if (status.done) return finish(status.stat);
    if (status.offset < offset)
      throw fatal('Google Drive reported an upload offset that went backwards');
    const advance = status.offset - offset;
    if (advance === 0) {
      stalls += 1;
      if (stalls >= MAX_STALLS)
        throw new ProviderError('Google Drive stopped confirming upload bytes');
      continue;
    }
    stalls = 0;
    pending = pending.slice(advance);
    offset = status.offset;
    await session.onSession?.({ uri: session.uri, offset, size });
    ctx.events?.onUploadProgress?.({ name, bytesConfirmed: offset, totalBytes: size });
  }
}

function checkHash(stat: FileStat, sha256: string): FileStat {
  if (stat.sha256 !== sha256.toLowerCase()) {
    throw fatal("the uploaded file's sha256 does not match the one given");
  }
  return stat;
}

/** Opens a session (POST, or PATCH for a new revision) and uploads `body` through it. */
export async function resumableUpload(
  ctx: ResumableContext,
  options: ResumableUploadOptions,
): Promise<FileStat> {
  const onRetry = ctx.events?.onRetry;
  const uri = await retry(
    async () => {
      const response = await ctx.client.rawOnce(
        'drive.upload.open',
        uploadUrl(options.existingId, { uploadType: 'resumable', fields: FILE_FIELDS }),
        {
          method: options.existingId === undefined ? 'POST' : 'PATCH',
          headers: {
            'content-type': 'application/json; charset=UTF-8',
            'x-upload-content-type': options.mimeType,
            'x-upload-content-length': String(options.size),
          },
          body: JSON.stringify(options.metadata),
        },
      );
      if (!response.ok) {
        throw mapDriveError(
          response.status,
          await readJson(response),
          response.headers,
          Date.now(),
        );
      }
      const location = response.headers.get('location');
      if (location === null) throw new ProviderError('Google Drive did not open an upload session');
      assertSessionUri(location);
      return location;
    },
    { operation: 'drive.upload.open', ...(onRetry === undefined ? {} : { onRetry }), ...ctx.retry },
  );
  const session: Session = {
    ctx,
    uri,
    size: options.size,
    name: options.name,
    onSession: options.onResumableSession,
  };
  await session.onSession?.({ uri, offset: 0, size: options.size });
  return checkHash(await run(session, options.body, 0), options.sha256);
}

/** Continues a session from the offset Drive confirmed, in this process or a new one. */
export async function resumeSession(
  ctx: ResumableContext,
  options: ResumeUploadOptions,
): Promise<FileStat> {
  assertSessionUri(options.session.uri);
  const session: Session = {
    ctx,
    uri: options.session.uri,
    size: options.session.size,
    name: options.name,
    onSession: options.onResumableSession,
  };
  const status = await queryStatus(session);
  if (status.done) return checkHash(status.stat, options.sha256);
  return checkHash(
    await run(session, await options.openAt(status.offset), status.offset),
    options.sha256,
  );
}
