import type { ResumableSession } from '@byos/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sha256Hex } from '../../src/api/upload.js';
import { driveError, type DriveRequest } from './fake-drive.js';
import { setup } from './setup.js';

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('real fetch called');
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const CHUNK = 256 * 1024;
const body = () => new Uint8Array(21 * CHUNK).fill(3);
const isChunk = (r: DriveRequest) =>
  r.method === 'PUT' && /^bytes \d+-\d+\//.test(r.headers['content-range'] ?? '');

describe('resumable session URI', () => {
  it('never appears in errors, hook events or console output', async () => {
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map(
      (method) => vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const payloads: unknown[] = [];
    const errors: Error[] = [];
    const sessions: ResumableSession[] = [];
    const events = {
      onRequest: (event: unknown) => payloads.push(event),
      onRetry: (event: unknown) => payloads.push(event),
      onUploadProgress: (event: unknown) => payloads.push(event),
    };
    const capture = async (work: Promise<unknown>) => {
      try {
        await work;
      } catch (error) {
        errors.push(error as Error);
      }
    };
    const record = (session: ResumableSession) => {
      sessions.push(session);
    };

    // A 503 retry, then a network error on every attempt of a chunk, then an expired session.
    const first = setup({ events, chunkSize: CHUNK });
    first.drive.failNext(/upload_id=/, driveError(503));
    const data = body();
    const sha256 = await sha256Hex(data);
    await first.provider.put({
      parent: { id: 'root' },
      name: 'a.bin',
      body: data,
      size: data.length,
      sha256,
      onResumableSession: record,
    });

    const second = setup({ events, chunkSize: CHUNK });
    second.drive.failNext(
      /upload_id=/,
      ...Array.from({ length: 5 }, () => new TypeError('fetch failed for upload_id=SECRET')),
    );
    await capture(
      second.provider.put({
        parent: { id: 'root' },
        name: 'b.bin',
        body: data,
        size: data.length,
        sha256,
        onResumableSession: record,
      }),
    );

    const third = setup({ events, chunkSize: CHUNK });
    await capture(
      third.provider.put({
        parent: { id: 'root' },
        name: 'c.bin',
        body: data,
        size: data.length,
        sha256,
        onResumableSession: (session) => {
          record(session);
          if (session.offset >= CHUNK) third.drive.expireSessions();
        },
      }),
    );
    expect(third.drive.requests.some(isChunk)).toBe(true);

    // Control: the URI did reach the consumer, and the capture saw events and errors.
    expect(sessions.some((s) => s.uri.includes('upload_id=SECRET-'))).toBe(true);
    expect(payloads.length).toBeGreaterThanOrEqual(3);
    expect(errors.length).toBeGreaterThanOrEqual(2);

    const captured = [
      ...errors.flatMap((e) => [e.message, String(e), JSON.stringify(e), e.stack ?? '']),
      JSON.stringify(payloads),
    ].join('\n');
    for (const secret of ['SECRET', 'upload_id', 'googleapis.com']) {
      expect(captured).not.toContain(secret);
    }
    for (const error of errors) expect(error.cause).toBeUndefined();
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });
});
