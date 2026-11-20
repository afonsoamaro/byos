import { ProviderError, type PutBody } from '@byos/core';

/** Above this, or with an unknown size, a file needs the resumable upload. */
export const SIMPLE_UPLOAD_LIMIT = 5 * 1024 * 1024;
/** Version of the metadata format BYOS writes into `appProperties`, not the package version. */
export const BYOS_METADATA_VERSION = '1';

const tooBig = () =>
  new ProviderError(
    'files over 5 MiB or of unknown size need the resumable upload, which is not implemented yet',
    { retryable: false },
  );

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > SIMPLE_UPLOAD_LIMIT) {
      await reader.cancel();
      throw tooBig();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/**
 * Reads a body of at most 5 MiB into memory, checking it against `size` when given. The
 * result is always a fresh `ArrayBuffer`-backed copy, which `fetch` and Web Crypto accept.
 */
export async function readBody(body: PutBody, size?: number): Promise<Uint8Array<ArrayBuffer>> {
  if (size !== undefined && size > SIMPLE_UPLOAD_LIMIT) throw tooBig();
  let bytes: Uint8Array<ArrayBuffer>;
  if (body instanceof Uint8Array) {
    if (body.length > SIMPLE_UPLOAD_LIMIT) throw tooBig();
    bytes = new Uint8Array(body);
  } else if (body instanceof Blob) {
    if (body.size > SIMPLE_UPLOAD_LIMIT) throw tooBig();
    bytes = new Uint8Array(await body.arrayBuffer());
  } else {
    if (size === undefined) throw tooBig();
    bytes = await readStream(body);
  }
  if (bytes.length > SIMPLE_UPLOAD_LIMIT) throw tooBig();
  if (size !== undefined && bytes.length !== size) {
    throw new ProviderError(
      `the body has ${String(bytes.length)} bytes but size says ${String(size)}`,
      { retryable: false },
    );
  }
  return bytes;
}

/** Lowercase hex SHA-256, via Web Crypto. */
export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * A `multipart/related` body for Drive's multipart upload: JSON metadata, then the bytes.
 * Built once as bytes, so the same body can be sent again on a retry.
 */
export function buildMultipart(
  metadata: Record<string, unknown>,
  bytes: Uint8Array,
  mimeType: string,
): { body: Uint8Array<ArrayBuffer>; contentType: string } {
  const random = crypto.getRandomValues(new Uint8Array(12));
  const boundary = `byos-${Array.from(random, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  const encoder = new TextEncoder();
  const head =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`;
  const tail = `\r\n--${boundary}--`;
  return {
    body: concat([encoder.encode(head), bytes, encoder.encode(tail)]),
    contentType: `multipart/related; boundary=${boundary}`,
  };
}
