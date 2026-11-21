import { ConflictError, PermissionError, ProviderError } from '@byos/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sha256Hex } from '../../src/api/upload.js';
import { driveError, FOLDER, type DriveRequest } from './fake-drive.js';
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
const writes = (drive: Drive) => drive.requests.filter((r) => r.method !== 'GET');
const body = (request: DriveRequest | undefined): unknown =>
  JSON.parse(new TextDecoder().decode(request?.body ?? new Uint8Array()) || '{}');

const tree = [
  { id: 'src', name: 'src', parents: ['root'], mimeType: FOLDER },
  { id: 'dst', name: 'dst', parents: ['root'], mimeType: FOLDER },
  { id: 'inner', name: 'inner', parents: ['src'], mimeType: FOLDER },
  { id: 'f1', name: 'a.txt', parents: ['src'], content: 'hello' },
];

describe('move', () => {
  it('sends addParents and removeParents and keeps the id', async () => {
    const { provider, drive } = setup({ files: tree });
    const moved = await provider.move({ id: 'f1' }, { parent: { id: 'dst' }, name: 'b.txt' });
    const request = writes(drive)[0];
    expect(request?.method).toBe('PATCH');
    expect(request?.url.searchParams.get('addParents')).toBe('dst');
    expect(request?.url.searchParams.get('removeParents')).toBe('src');
    expect(body(request)).toEqual({ name: 'b.txt' });
    expect(moved).toMatchObject({ id: 'f1', name: 'b.txt', parents: ['dst'] });
  });

  it('a rename alone sends no parent change', async () => {
    const { provider, drive } = setup({ files: tree });
    await provider.move({ id: 'f1' }, { name: 'c.txt' });
    const request = writes(drive)[0];
    expect(request?.url.searchParams.has('addParents')).toBe(false);
    expect(body(request)).toEqual({ name: 'c.txt' });
  });

  it('the same parent and name sends nothing', async () => {
    const { provider, drive } = setup({ files: tree });
    const same = await provider.move({ id: 'f1' }, { parent: { id: 'src' }, name: 'a.txt' });
    expect(same.id).toBe('f1');
    expect(writes(drive)).toHaveLength(0);
  });

  it('refuses to move a folder into itself or below itself', async () => {
    const { provider, drive } = setup({ files: tree });
    await expect(provider.move({ id: 'src' }, { parent: { id: 'src' } })).rejects.toBeInstanceOf(
      ProviderError,
    );
    await expect(provider.move({ id: 'src' }, { parent: { id: 'inner' } })).rejects.toBeInstanceOf(
      ProviderError,
    );
    expect(writes(drive)).toHaveLength(0);
  });

  it('a move onto an existing name sends nothing', async () => {
    const { provider, drive } = setup({
      files: [...tree, { id: 'f2', name: 'b.txt', parents: ['dst'], content: 'x' }],
    });
    await expect(
      provider.move({ id: 'f1' }, { parent: { id: 'dst' }, name: 'b.txt' }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(writes(drive)).toHaveLength(0);
  });

  it('moves by path and forgets the old path', async () => {
    const { provider } = setup({ files: tree });
    await provider.stat({ path: 'src/a.txt' });
    await provider.move({ path: 'src/a.txt' }, { parent: { path: 'dst' } });
    expect(await provider.stat({ path: 'src/a.txt' })).toBeUndefined();
    expect((await provider.stat({ path: 'dst/a.txt' }))?.id).toBe('f1');
  });
});

describe('the root', () => {
  it('cannot be moved either', async () => {
    const { provider, drive } = setup({ files: tree });
    await expect(provider.move({ path: '' }, { name: 'elsewhere' })).rejects.toBeInstanceOf(
      ProviderError,
    );
    expect(writes(drive)).toHaveLength(0);
  });
});

describe('copy', () => {
  const hash = async () => sha256Hex(new TextEncoder().encode('hello'));

  it('sends the target parent and the BYOS hash in the body', async () => {
    const sha = await hash();
    const { provider, drive } = setup({
      files: [
        ...tree.slice(0, 3),
        {
          id: 'f1',
          name: 'a.txt',
          parents: ['src'],
          content: 'hello',
          appProperties: { byosSha256: sha, byosVersion: '1' },
        },
      ],
    });
    const copy = await provider.copy({ id: 'f1' }, { parent: { id: 'dst' } });
    const request = writes(drive)[0];
    expect(request?.method).toBe('POST');
    expect(request?.url.pathname).toBe('/drive/v3/files/f1/copy');
    expect(body(request)).toEqual({
      name: 'a.txt',
      parents: ['dst'],
      appProperties: { byosSha256: sha, byosVersion: '1' },
    });
    expect(copy).toMatchObject({ name: 'a.txt', sha256: sha });
    expect(copy.id).not.toBe('f1');
  });

  it('refuses a folder and an existing name without a request', async () => {
    const { provider, drive } = setup({
      files: [...tree, { id: 'f2', name: 'a.txt', parents: ['dst'], content: 'x' }],
    });
    await expect(provider.copy({ id: 'inner' }, { parent: { id: 'dst' } })).rejects.toBeInstanceOf(
      ProviderError,
    );
    await expect(provider.copy({ id: 'f1' }, { parent: { id: 'dst' } })).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(writes(drive)).toHaveLength(0);
  });

  it('leaves exactly one copy when the answer is lost', async () => {
    const { provider, drive } = setup({ files: tree });
    drive.failAfterApply(/\/copy\?/, driveError(503));
    const copy = await provider.copy({ id: 'f1' }, { parent: { id: 'dst' } });
    const copies = [...drive.files.values()].filter(
      (f) => f.name === 'a.txt' && f.parents.includes('dst'),
    );
    expect(copies).toHaveLength(1);
    expect(copy.id).toBe(copies[0]?.id);
  });
});

describe('delete', () => {
  it('trashes by default with a PATCH', async () => {
    const { provider, drive } = setup({ files: tree });
    await provider.delete({ id: 'f1' });
    const request = writes(drive)[0];
    expect(request?.method).toBe('PATCH');
    expect(body(request)).toEqual({ trashed: true });
    expect(drive.files.get('f1')?.trashed).toBe(true);
  });

  it('deletes for good only with permanent, with a DELETE', async () => {
    const { provider, drive } = setup({ files: tree });
    await provider.delete({ id: 'f1' }, { permanent: true });
    expect(writes(drive)[0]?.method).toBe('DELETE');
    expect(drive.files.has('f1')).toBe(false);
  });

  it('removes the children with a permanently deleted folder', async () => {
    const { provider, drive } = setup({ files: tree });
    await provider.delete({ id: 'src' }, { permanent: true });
    expect([...drive.files.keys()].filter((id) => ['src', 'inner', 'f1'].includes(id))).toEqual([]);
  });

  it('counts a permanent delete that finds nothing on a retry as done', async () => {
    const { provider, drive } = setup({ files: tree });
    drive.failAfterApply(/\/files\/f1$/, driveError(503));
    await expect(provider.delete({ id: 'f1' }, { permanent: true })).resolves.toBeUndefined();
    expect(drive.files.has('f1')).toBe(false);
  });

  it('never deletes the root', async () => {
    const { provider, drive } = setup({ files: tree });
    await expect(provider.delete({ id: 'root' })).rejects.toBeInstanceOf(ProviderError);
    await expect(provider.delete({ path: '' }, { permanent: true })).rejects.toBeInstanceOf(
      ProviderError,
    );
    expect(writes(drive)).toHaveLength(0);
  });
});

describe('files this app did not create', () => {
  it('are refused with PermissionError and no retry', async () => {
    const { provider, drive } = setup({
      files: [{ id: 'other', name: 'theirs.txt', parents: ['root'], content: 'x', foreign: true }],
    });
    await expect(provider.move({ id: 'other' }, { name: 'mine.txt' })).rejects.toBeInstanceOf(
      PermissionError,
    );
    expect(writes(drive)).toHaveLength(1);
    await expect(provider.delete({ id: 'other' })).rejects.toBeInstanceOf(PermissionError);
    await expect(provider.delete({ id: 'other' }, { permanent: true })).rejects.toBeInstanceOf(
      PermissionError,
    );
    await expect(
      provider.copy({ id: 'other' }, { parent: { id: 'root' }, name: 'copy.txt' }),
    ).rejects.toBeInstanceOf(PermissionError);
  });
});
