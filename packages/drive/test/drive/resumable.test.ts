import { ConflictError, ProviderError, type ResumableSession } from '@byos/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DriveProvider } from '../../src/index.js';
import { sha256Hex } from '../../src/api/upload.js';
import { driveError, type DriveRequest } from './fake-drive.js';
import { setup } from './setup.js';

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('real fetch called');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const KiB = 1024;
const MiB = 1024 * KiB;
const CHUNK = 256 * KiB;

/** Deterministic content that differs from chunk to chunk, so a misplaced byte shows. */
function pattern(size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) bytes[i] = (i * 31 + (i >> 8)) % 251;
  return bytes;
}

type Drive = ReturnType<typeof setup>['drive'];
const range = (r: DriveRequest) => r.headers['content-range'] ?? '';
const isChunk = (r: DriveRequest) => r.method === 'PUT' && /^bytes \d+-\d+\//.test(range(r));
const chunkRequests = (drive: Drive) => drive.requests.filter(isChunk);
const statusQueries = (drive: Drive) =>
  drive.requests.filter((r) => range(r).startsWith('bytes */'));
const starts = (drive: Drive) =>
  chunkRequests(drive).map((r) => Number(/^bytes (\d+)-/.exec(range(r))?.[1]));
/** Failure injection for chunk requests (only those carry `upload_id`). */
const CHUNK_REQUEST = /upload_id=/;

async function upload(provider: DriveProvider, body: Uint8Array<ArrayBuffer>, extra: object = {}) {
  return provider.put({
    parent: { id: 'root' },
    name: 'video.mp4',
    body,
    size: body.length,
    sha256: await sha256Hex(body),
    ...extra,
  });
}

describe('resumable upload', () => {
  it('uploads 50 MiB in 7 chunks of 8 MiB and reports 100 %', async () => {
    const progress: number[] = [];
    const { provider, drive } = setup({
      events: { onUploadProgress: (e) => progress.push(e.bytesConfirmed) },
    });
    const body = pattern(50 * MiB);
    const stat = await upload(provider, body);
    expect(chunkRequests(drive)).toHaveLength(7);
    expect(progress.at(-1)).toBe(body.length);
    expect(stat).toMatchObject({
      sha256: await sha256Hex(body),
      size: body.length,
      mimeType: 'video/mp4',
    });
    expect(drive.files.get(stat.id)?.bytes).toEqual(body);
  }, 30_000);

  it('sends full 256 KiB-aligned chunks, with no empty final chunk on an exact multiple', async () => {
    const { provider, drive } = setup({ chunkSize: CHUNK });
    const body = pattern(24 * CHUNK);
    const stat = await upload(provider, body);
    expect(chunkRequests(drive)).toHaveLength(24);
    for (const start of starts(drive)) expect(start % CHUNK).toBe(0);
    for (const request of chunkRequests(drive)) expect(request.body?.length).toBe(CHUNK);
    expect(drive.files.get(stat.id)?.bytes).toEqual(body);
  });

  it('continues from the offset Drive confirmed when it keeps fewer bytes than sent', async () => {
    const { provider, drive } = setup({ chunkSize: 2 * CHUNK });
    const body = pattern(22 * CHUNK + 1000);
    drive.confirmShort(CHUNK);
    const stat = await upload(provider, body);
    expect(starts(drive).slice(0, 3)).toEqual([0, CHUNK, 3 * CHUNK]);
    expect(drive.files.get(stat.id)?.bytes).toEqual(body);
  });

  it('retries a failed chunk from the offset Drive reports', async () => {
    const { provider, drive } = setup({ chunkSize: CHUNK });
    const body = pattern(22 * CHUNK);
    drive.failNext(CHUNK_REQUEST, driveError(503));
    const stat = await upload(provider, body);
    expect(statusQueries(drive)).toHaveLength(1);
    expect(drive.files.get(stat.id)?.bytes).toEqual(body);
  });

  it('finishes without a second file when the final response is lost', async () => {
    const { provider, drive } = setup({ chunkSize: 16 * CHUNK });
    const body = pattern(21 * CHUNK);
    drive.failAfterApplyWhen(
      (r) => isChunk(r) && range(r).endsWith(`-${String(body.length - 1)}/${String(body.length)}`),
      driveError(503),
    );
    const stat = await upload(provider, body);
    expect(statusQueries(drive)).toHaveLength(1);
    expect([...drive.files.values()].filter((f) => f.name === 'video.mp4')).toHaveLength(1);
    expect(drive.files.get(stat.id)?.bytes).toEqual(body);
  });

  it('awaits onResumableSession before sending the next chunk', async () => {
    const { provider, drive } = setup({ chunkSize: CHUNK });
    const body = pattern(22 * CHUNK);
    const seen: ResumableSession[] = [];
    await upload(provider, body, {
      onResumableSession: async (session: ResumableSession) => {
        const before = drive.requests.length;
        await new Promise((resolve) => setTimeout(resolve, 2));
        expect(drive.requests.length).toBe(before);
        seen.push(session);
      },
    });
    expect(seen[0]?.offset).toBe(0);
    expect(seen.map((s) => s.offset).slice(1, 3)).toEqual([CHUNK, 2 * CHUNK]);
    expect(seen.at(-1)?.size).toBe(body.length);
  });
});

describe('stream bodies and safeguards', () => {
  it('uploads a stream read in irregular pieces', async () => {
    const { provider, drive } = setup({ chunkSize: CHUNK });
    const body = pattern(22 * CHUNK + 4321);
    let at = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (at >= body.length) {
          controller.close();
          return;
        }
        const piece = body.slice(at, at + 100 * KiB + (at % 7));
        at += piece.length;
        controller.enqueue(piece);
      },
    });
    const stat = await provider.put({
      parent: { id: 'root' },
      name: 'stream.bin',
      body: stream,
      size: body.length,
      sha256: await sha256Hex(body),
    });
    for (const request of chunkRequests(drive).slice(0, -1))
      expect(request.body?.length).toBe(CHUNK);
    expect(drive.files.get(stat.id)?.bytes).toEqual(body);
  });

  it('fails when the content is shorter than its size', async () => {
    const { provider } = setup({ chunkSize: CHUNK });
    const body = pattern(21 * CHUNK);
    await expect(
      provider.put({
        parent: { id: 'root' },
        name: 'a.bin',
        body,
        size: 22 * CHUNK,
        sha256: 'a'.repeat(64),
      }),
    ).rejects.toThrow(/ended at byte/);
  });

  it('gives up when Drive stops confirming bytes', async () => {
    const { provider, drive } = setup({ chunkSize: CHUNK });
    // A 308 without Range: nothing confirmed, three times in a row.
    drive.failNext(CHUNK_REQUEST, { status: 308 }, { status: 308 }, { status: 308 });
    await expect(upload(provider, pattern(21 * CHUNK))).rejects.toThrow(/stopped confirming/);
  });
});

describe('resumeUpload', () => {
  async function interrupted(stopAt: number, keep: (offset: number) => boolean) {
    const { provider, drive, manager } = setup({ chunkSize: CHUNK });
    const body = pattern(23 * CHUNK + 777);
    let kept: ResumableSession | undefined;
    await expect(
      upload(provider, body, {
        onResumableSession: (session: ResumableSession) => {
          if (keep(session.offset)) kept = session;
          if (session.offset >= stopAt) throw new Error('process killed');
        },
      }),
    ).rejects.toThrow('process killed');
    return { drive, manager, body, kept: kept as ResumableSession };
  }

  it('resumes in a new provider from the offset Drive reports', async () => {
    const { drive, manager, body, kept } = await interrupted(2 * CHUNK, () => true);
    const fresh = new DriveProvider({
      tokens: manager,
      fetch: drive.fetch,
      chunkSize: CHUNK,
      retry: { random: () => 0 },
    });
    const before = drive.requests.length;
    const openAt = vi.fn((offset: number) => body.slice(offset));
    const stat = await fresh.resumeUpload({
      session: kept,
      name: 'video.mp4',
      sha256: await sha256Hex(body),
      openAt,
    });
    expect(range(drive.requests[before] as DriveRequest)).toBe(`bytes */${String(body.length)}`);
    expect(openAt).toHaveBeenCalledWith(2 * CHUNK);
    expect(drive.files.get(stat.id)?.bytes).toEqual(body);
  });

  it('opens the content where Drive is, even ahead of the saved offset', async () => {
    const { drive, manager, body, kept } = await interrupted(
      2 * CHUNK,
      (offset) => offset <= CHUNK,
    );
    expect(kept.offset).toBe(CHUNK);
    const fresh = new DriveProvider({ tokens: manager, fetch: drive.fetch, chunkSize: CHUNK });
    const openAt = vi.fn((offset: number) => new Blob([body.slice(offset)]));
    const stat = await fresh.resumeUpload({
      session: kept,
      name: 'video.mp4',
      sha256: await sha256Hex(body),
      openAt,
    });
    expect(openAt).toHaveBeenCalledWith(2 * CHUNK);
    expect(drive.files.get(stat.id)?.bytes).toEqual(body);
  });

  it('reports an expired session with the restart code', async () => {
    const { drive, manager, body, kept } = await interrupted(CHUNK, () => true);
    drive.expireSessions();
    const fresh = new DriveProvider({ tokens: manager, fetch: drive.fetch, chunkSize: CHUNK });
    const error: unknown = await fresh
      .resumeUpload({
        session: kept,
        name: 'video.mp4',
        sha256: await sha256Hex(body),
        openAt: () => body,
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code: 'UPLOAD_SESSION_EXPIRED', retryable: false });
  });

  it('reports a session that expires mid-upload with the restart code', async () => {
    const { provider, drive } = setup({ chunkSize: CHUNK });
    const body = pattern(22 * CHUNK);
    await expect(
      upload(provider, body, {
        onResumableSession: (session: ResumableSession) => {
          if (session.offset >= CHUNK) drive.expireSessions();
        },
      }),
    ).rejects.toMatchObject({ code: 'UPLOAD_SESSION_EXPIRED' });
  });
});

describe('session URI validation', () => {
  it.each([
    'https://evil.example/upload/drive/v3/files?uploadType=resumable&upload_id=X',
    'http://www.googleapis.com/upload/drive/v3/files?upload_id=X',
    'https://www.googleapis.com.evil.example/upload/drive/v3/files?upload_id=X',
    'https://user@www.googleapis.com/upload/drive/v3/files?upload_id=X',
    'https://www.googleapis.com:8443/upload/drive/v3/files?upload_id=X',
    'https://www.googleapis.com/drive/v3/files?upload_id=X',
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable',
    'not a url',
  ])('resumeUpload refuses %s before sending anything', async (uri) => {
    const { provider, drive } = setup();
    await expect(
      provider.resumeUpload({
        session: { uri, offset: 0, size: 10 },
        name: 'a',
        sha256: 'a'.repeat(64),
        openAt: () => new Uint8Array(10),
      }),
    ).rejects.toThrow('invalid upload session');
    expect(drive.requests).toHaveLength(0);
  });

  it('refuses a Location header that is not a Drive upload session', async () => {
    const { provider, drive } = setup({ chunkSize: 32 * CHUNK });
    drive.failNext(/uploadType=resumable&/, {
      status: 200,
      headers: { location: 'https://evil.example/upload/drive/v3/files?upload_id=X' },
    });
    await expect(upload(provider, pattern(21 * CHUNK))).rejects.toThrow('invalid upload session');
    expect(drive.requests.some((r) => r.url.hostname === 'evil.example')).toBe(false);
  });
});

describe('put rules over 5 MiB', () => {
  it('needs sha256, and a size for a stream', async () => {
    const { provider, drive } = setup();
    const body = pattern(6 * MiB);
    await expect(provider.put({ parent: { id: 'root' }, name: 'a', body })).rejects.toThrow(
      /sha256 is required/,
    );
    await expect(
      provider.put({
        parent: { id: 'root' },
        name: 'a',
        body: new Blob([body]).stream(),
        sha256: 'a'.repeat(64),
      }),
    ).rejects.toThrow(/size is required/);
    expect(drive.requests).toHaveLength(0);
  });

  it('refuses a finished upload whose stored hash differs from the one given', async () => {
    const { provider } = setup({ chunkSize: 32 * CHUNK });
    const body = pattern(21 * CHUNK);
    let last: ResumableSession | undefined;
    await upload(provider, body, {
      onResumableSession: (session: ResumableSession) => {
        last = session;
      },
    });
    const error: unknown = await provider
      .resumeUpload({
        session: last as ResumableSession,
        name: 'video.mp4',
        sha256: 'b'.repeat(64),
        openAt: () => body,
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as Error).message).toMatch(/sha256 does not match/);
  });

  it('overwrites a large file as a new revision of the same id', async () => {
    const { provider, drive } = setup({ chunkSize: 32 * CHUNK });
    const first = await upload(provider, pattern(21 * CHUNK));
    await expect(upload(provider, pattern(22 * CHUNK))).rejects.toBeInstanceOf(ConflictError);
    const body = pattern(23 * CHUNK);
    const second = await upload(provider, body, { overwrite: true });
    expect(second.id).toBe(first.id);
    expect(
      drive.requests.some(
        (r) => r.method === 'PATCH' && r.url.searchParams.get('uploadType') === 'resumable',
      ),
    ).toBe(true);
    expect(drive.files.get(first.id)?.bytes).toEqual(body);
  });

  it('refuses a chunk size that is not a positive multiple of 256 KiB', () => {
    const { manager, drive } = setup();
    for (const chunkSize of [100 * KiB, 0, -CHUNK]) {
      expect(() => new DriveProvider({ tokens: manager, fetch: drive.fetch, chunkSize })).toThrow(
        /256 KiB/,
      );
    }
  });
});
