import { ConflictError, NotFoundError, ProviderError } from '@byos/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FOLDER, type FakeFile } from './fake-drive.js';
import { setup } from './setup.js';

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('real fetch called');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const SHA = 'a'.repeat(64);
const tree: FakeFile[] = [
  { id: 'd1', name: 'a', parents: ['root'], mimeType: FOLDER },
  { id: 'd2', name: 'b', parents: ['d1'], mimeType: FOLDER },
  {
    id: 'f1',
    name: 'photo.jpg',
    parents: ['d2'],
    mimeType: 'image/jpeg',
    content: 'jpeg-bytes',
    md5Checksum: 'md5-1',
    appProperties: { byosSha256: SHA, byosVersion: '1' },
  },
  { id: 'doc', name: 'notes', parents: ['root'], mimeType: 'application/vnd.google-apps.document' },
  { id: 'gone', name: 'old.txt', parents: ['root'], content: 'x', trashed: true },
];

describe('list', () => {
  it('pages through 250 children in order', async () => {
    const files: FakeFile[] = [
      { id: 'big', name: 'big', parents: ['root'], mimeType: FOLDER },
      ...Array.from({ length: 250 }, (_, i) => ({
        id: `p${String(i)}`,
        name: `p${String(i).padStart(3, '0')}`,
        parents: ['big'],
        content: 'x',
      })),
    ];
    const { provider, drive } = setup({ files });
    const names: string[] = [];
    let pageToken: string | undefined;
    let pages = 0;
    do {
      const page = await provider.list({
        parent: { id: 'big' },
        pageSize: 100,
        ...(pageToken === undefined ? {} : { pageToken }),
      });
      names.push(...page.items.map((item) => item.name));
      pageToken = page.nextPageToken;
      pages += 1;
    } while (pageToken !== undefined);
    expect(pages).toBe(3);
    expect(names).toEqual(files.slice(1).map((f) => f.name));
    const listRequest = drive.requests.find((r) => r.url.searchParams.has('q'));
    expect(listRequest?.url.searchParams.get('q')).toBe("'big' in parents and trashed = false");
    expect(listRequest?.url.searchParams.get('fields')).toMatch(/^nextPageToken,files\(id,name,/);
    expect(listRequest?.url.searchParams.get('orderBy')).toBe('folder,name_natural');
    // The parent is checked on the first page only.
    expect(drive.requests.filter((r) => /\/files\/big\?/.test(r.url.href))).toHaveLength(1);
  });

  it('clamps pageSize to 1..1000', async () => {
    const { provider, drive } = setup({ files: tree });
    await provider.list({ parent: { id: 'root' }, pageSize: 0 });
    await provider.list({ parent: { id: 'root' }, pageSize: 5000 });
    const sizes = drive.requests
      .filter((r) => r.url.searchParams.has('q'))
      .map((r) => r.url.searchParams.get('pageSize'));
    expect(sizes).toEqual(['1', '1000']);
  });

  it('lists a folder given by path, and refuses a missing parent', async () => {
    const { provider } = setup({ files: tree });
    const page = await provider.list({ parent: { path: 'a/b' } });
    expect(page.items.map((item) => item.name)).toEqual(['photo.jpg']);
    await expect(provider.list({ parent: { id: 'nope' } })).rejects.toBeInstanceOf(NotFoundError);
    await expect(provider.list({ parent: { id: 'f1' } })).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('stat', () => {
  it('maps every field of a Drive file', async () => {
    const { provider } = setup({ files: tree });
    expect(await provider.stat({ id: 'f1' })).toEqual({
      id: 'f1',
      name: 'photo.jpg',
      parents: ['d2'],
      isFolder: false,
      mimeType: 'image/jpeg',
      size: 10,
      modifiedAt: '2026-11-01T10:00:00.000Z',
      createdAt: '2026-11-01T09:00:00.000Z',
      md5: 'md5-1',
      sha256: SHA,
      appProperties: { byosSha256: SHA, byosVersion: '1' },
    });
    expect((await provider.stat({ id: 'd1' }))?.isFolder).toBe(true);
  });

  it('resolves to undefined for a missing id, a trashed file and a missing path', async () => {
    const { provider } = setup({ files: tree });
    expect(await provider.stat({ id: 'nope' })).toBeUndefined();
    expect(await provider.stat({ id: 'gone' })).toBeUndefined();
    expect(await provider.stat({ path: 'a/missing.jpg' })).toBeUndefined();
  });

  it('stats by path, then answers the same path from the cache', async () => {
    const { provider, drive } = setup({ files: tree });
    expect((await provider.stat({ path: 'a/b/photo.jpg' }))?.id).toBe('f1');
    const lookups = () => drive.requests.filter((r) => r.url.searchParams.has('q')).length;
    expect(lookups()).toBe(3);
    await provider.stat({ path: 'a/b/photo.jpg' });
    expect(lookups()).toBe(3);
  });

  it('raises ConflictError for duplicate names on a path', async () => {
    const { provider } = setup({
      files: [
        { id: 'x1', name: 'dup.txt', parents: ['root'], content: '1' },
        { id: 'x2', name: 'dup.txt', parents: ['root'], content: '2' },
      ],
    });
    await expect(provider.stat({ path: 'dup.txt' })).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('get', () => {
  it('streams the content by id and by path', async () => {
    const { provider } = setup({ files: tree });
    expect(await new Response(await provider.get({ id: 'f1' })).text()).toBe('jpeg-bytes');
    expect(await new Response(await provider.get({ path: 'a/b/photo.jpg' })).text()).toBe(
      'jpeg-bytes',
    );
  });

  it('refuses folders and Google Docs with clear errors', async () => {
    const { provider } = setup({ files: tree });
    await expect(provider.get({ id: 'd1' })).rejects.toThrow(/is a folder/);
    await expect(provider.get({ id: 'doc' })).rejects.toThrow(/export is not supported/);
    await expect(provider.get({ id: 'gone' })).rejects.toBeInstanceOf(NotFoundError);
  });
});
