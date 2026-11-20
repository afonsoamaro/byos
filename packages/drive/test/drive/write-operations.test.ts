import { ConflictError, NotFoundError, ProviderError, QuotaExceededError } from '@byos/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sha256Hex } from '../../src/api/upload.js';
import { driveError, FOLDER, parseMultipart } from './fake-drive.js';
import { setup } from './setup.js';

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('real fetch called');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

type Drive = ReturnType<typeof setup>['drive'];
const posts = (drive: Drive, path: RegExp) =>
  drive.requests.filter((r) => r.method !== 'GET' && path.test(r.url.pathname));
const FOLDER_CREATE = /^\/drive\/v3\/files$/;
const UPLOAD = /^\/upload\/drive\/v3\/files/;
/** For failure injection, which matches path and query: a folder create is `/files?fields=...`, a lookup `/files?q=...`. */
const FOLDER_CREATE_REQUEST = /^\/drive\/v3\/files\?fields=/;

describe('mkdir', () => {
  it('creates missing levels with parents, and is idempotent', async () => {
    const { provider, drive } = setup();
    const made = await provider.mkdir({
      parent: { path: 'Documents' },
      name: '2026-11',
      parents: true,
    });
    expect(made).toMatchObject({ name: '2026-11', isFolder: true });
    expect(posts(drive, FOLDER_CREATE)).toHaveLength(2);
    const again = await provider.mkdir({
      parent: { path: 'Documents' },
      name: '2026-11',
      parents: true,
    });
    expect(again.id).toBe(made.id);
    expect(posts(drive, FOLDER_CREATE)).toHaveLength(2);
  });

  it('makes one folder for two parallel calls on the same path', async () => {
    const { provider, drive } = setup();
    const [a, b] = await Promise.all([
      provider.mkdir({ parent: { path: 'A/B' }, name: 'C', parents: true }),
      provider.mkdir({ parent: { path: 'A/B' }, name: 'C', parents: true }),
    ]);
    expect(a.id).toBe(b.id);
    expect(posts(drive, FOLDER_CREATE)).toHaveLength(3);
    expect([...drive.files.values()].filter((f) => f.name === 'C')).toHaveLength(1);
  });

  it('refuses a file in the way, and a missing parent without parents', async () => {
    const { provider } = setup({
      files: [{ id: 'f', name: 'x', parents: ['root'], content: '1' }],
    });
    await expect(
      provider.mkdir({ parent: { path: 'x' }, name: 'y', parents: true }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(provider.mkdir({ parent: { id: 'root' }, name: 'x' })).rejects.toBeInstanceOf(
      ConflictError,
    );
    await expect(provider.mkdir({ parent: { path: 'missing' }, name: 'y' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('does not duplicate a folder whose creation answer was lost', async () => {
    const onRetry = vi.fn();
    const { provider, drive } = setup({ events: { onRetry } });
    drive.failAfterApply(FOLDER_CREATE_REQUEST, driveError(503));
    const made = await provider.mkdir({ parent: { id: 'root' }, name: 'Once' });
    expect(posts(drive, FOLDER_CREATE)).toHaveLength(1);
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ operation: 'drive.mkdir' }));
    expect([...drive.files.values()].filter((f) => f.name === 'Once')).toHaveLength(1);
    expect(made.id).toBe([...drive.files.values()].find((f) => f.name === 'Once')?.id);
  });
});

describe('put', () => {
  const jpeg = new Uint8Array(200 * 1024).fill(7);

  it('uploads metadata with byosSha256 and the exact bytes', async () => {
    const progress = vi.fn();
    const { provider, drive } = setup({ events: { onUploadProgress: progress } });
    const folder = await provider.mkdir({
      parent: { path: 'Photos' },
      name: '2026',
      parents: true,
    });
    const stat = await provider.put({
      parent: { id: folder.id },
      name: 'IMG_0001.jpg',
      body: jpeg,
    });

    const upload = posts(drive, UPLOAD)[0];
    expect(upload?.method).toBe('POST');
    expect(upload?.url.searchParams.get('uploadType')).toBe('multipart');
    const parts = parseMultipart(
      upload?.body ?? new Uint8Array(),
      upload?.headers['content-type'] ?? '',
    );
    const sha = await sha256Hex(new Uint8Array(jpeg));
    expect(parts.metadata).toEqual({
      name: 'IMG_0001.jpg',
      parents: [folder.id],
      mimeType: 'image/jpeg',
      appProperties: { byosSha256: sha, byosVersion: '1' },
    });
    expect(parts.mimeType).toBe('image/jpeg');
    expect(parts.bytes).toEqual(jpeg);
    expect(stat).toMatchObject({ name: 'IMG_0001.jpg', sha256: sha, size: jpeg.length });
    expect(progress).toHaveBeenCalledOnce();
    expect(progress).toHaveBeenCalledWith({
      name: 'IMG_0001.jpg',
      bytesConfirmed: jpeg.length,
      totalBytes: jpeg.length,
    });
  });

  it('accepts a matching caller sha256 and refuses a wrong one without uploading', async () => {
    const { provider, drive } = setup();
    const sha = await sha256Hex(new TextEncoder().encode('hello'));
    await expect(
      provider.put({
        parent: { id: 'root' },
        name: 'a.txt',
        body: new TextEncoder().encode('hello'),
        sha256: sha,
      }),
    ).resolves.toMatchObject({ sha256: sha });
    const before = posts(drive, UPLOAD).length;
    await expect(
      provider.put({
        parent: { id: 'root' },
        name: 'b.txt',
        body: new TextEncoder().encode('hello'),
        sha256: 'a'.repeat(64),
      }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(posts(drive, UPLOAD)).toHaveLength(before);
  });

  it('refuses an existing name without overwrite, and keeps the id with it', async () => {
    const { provider, drive } = setup();
    const first = await provider.put({
      parent: { id: 'root' },
      name: 'a.txt',
      body: new TextEncoder().encode('one'),
    });
    await expect(
      provider.put({
        parent: { id: 'root' },
        name: 'a.txt',
        body: new TextEncoder().encode('two'),
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(posts(drive, UPLOAD)).toHaveLength(1);
    const second = await provider.put({
      parent: { id: 'root' },
      name: 'a.txt',
      body: new TextEncoder().encode('two!'),
      overwrite: true,
    });
    expect(second.id).toBe(first.id);
    const patch = posts(drive, UPLOAD).at(-1);
    expect(patch?.method).toBe('PATCH');
    const patched = parseMultipart(
      patch?.body ?? new Uint8Array(),
      patch?.headers['content-type'] ?? '',
    );
    expect(patched.metadata).toMatchObject({
      appProperties: {
        byosSha256: await sha256Hex(new TextEncoder().encode('two!')),
        byosVersion: '1',
      },
    });
    expect(second.sha256).toBe(await sha256Hex(new TextEncoder().encode('two!')));
    expect(await new Response(await provider.get({ id: first.id })).text()).toBe('two!');
  });

  it('refuses a name that is a folder', async () => {
    const { provider } = setup({
      files: [{ id: 'd', name: 'dir', parents: ['root'], mimeType: FOLDER }],
    });
    await expect(
      provider.put({
        parent: { id: 'root' },
        name: 'dir',
        body: new Uint8Array([1]),
        overwrite: true,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('surfaces a full Drive as QuotaExceededError without retrying', async () => {
    const { provider, drive } = setup();
    drive.failNext(UPLOAD, driveError(403, 'storageQuotaExceeded'));
    await expect(
      provider.put({ parent: { id: 'root' }, name: 'a.txt', body: new Uint8Array([1]) }),
    ).rejects.toBeInstanceOf(QuotaExceededError);
    expect(posts(drive, UPLOAD)).toHaveLength(1);
  });

  it('does not duplicate a file whose upload answer was lost', async () => {
    const { provider, drive } = setup();
    drive.failAfterApply(UPLOAD, driveError(503));
    const stat = await provider.put({
      parent: { id: 'root' },
      name: 'once.txt',
      body: new TextEncoder().encode('x'),
    });
    const copies = [...drive.files.values()].filter((f) => f.name === 'once.txt');
    expect(copies).toHaveLength(1);
    expect(stat.id).toBe(copies[0]?.id);
    expect(posts(drive, UPLOAD)).toHaveLength(1);
  });
});
