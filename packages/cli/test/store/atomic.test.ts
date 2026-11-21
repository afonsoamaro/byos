import { chmod, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { StoredToken } from '@byos/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ensurePrivateDir,
  writeFileAtomic,
  writeFileExclusive,
} from '../../src/store/atomic-write.js';
import { FileTokenStore } from '../../src/store/file-token-store.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'byos-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const token = (n: number): StoredToken => ({
  accessToken: `ACCESS-${String(n)}`,
  refreshToken: `REFRESH-${String(n)}`,
  expiresAt: 1_800_000_000_000 + n,
  scopes: ['https://www.googleapis.com/auth/drive.file'],
  consentedAt: 1_790_000_000_000,
});

describe('atomic writes', () => {
  it('a crash between the temp file and the rename leaves the old token valid and no temp file', async () => {
    const env = { BYOS_TOKEN_KEY: Buffer.alloc(32, 3).toString('base64') };
    await new FileTokenStore({ configDir: dir, env }).save('default', token(1));
    const crashing = new FileTokenStore({
      configDir: dir,
      env,
      atomicHooks: {
        beforeRename: () => {
          throw new Error('crashed here');
        },
      },
    });
    await expect(crashing.save('default', token(2))).rejects.toThrow('crashed here');
    expect(await new FileTokenStore({ configDir: dir, env }).load('default')).toEqual(token(1));
    expect(await readdir(join(dir, 'tokens'))).toEqual(['default.json']);
  });

  it('two saves at once leave one whole token, never a decrypt error', async () => {
    const env = { BYOS_TOKEN_KEY: Buffer.alloc(32, 3).toString('base64') };
    const a = new FileTokenStore({ configDir: dir, env });
    const b = new FileTokenStore({ configDir: dir, env });
    await Promise.all([a.save('default', token(1)), b.save('default', token(2))]);
    const loaded = await a.load('default');
    expect([token(1), token(2)]).toContainEqual(loaded);
    expect((await readdir(join(dir, 'tokens'))).filter((name) => name.endsWith('.tmp'))).toEqual(
      [],
    );
  });

  it('two first uses at once converge on one key and read each other', async () => {
    const a = new FileTokenStore({ configDir: dir, env: {} });
    const b = new FileTokenStore({ configDir: dir, env: {} });
    await Promise.all([a.save('one', token(1)), b.save('two', token(2))]);
    expect(await b.load('one')).toEqual(token(1));
    expect(await a.load('two')).toEqual(token(2));
  });

  it('writeFileAtomic replaces the content, and writeFileExclusive never replaces', async () => {
    const path = join(dir, 'file');
    expect(await writeFileExclusive(path, 'first')).toBe(true);
    expect(await writeFileExclusive(path, 'second')).toBe(false);
    expect(await readFile(path, 'utf8')).toBe('first');
    await writeFileAtomic(path, 'third');
    expect(await readFile(path, 'utf8')).toBe('third');
    expect((await readdir(dir)).sort()).toEqual(['file']);
  });
});

describe('filesystems without hard links', () => {
  const noLinks = () =>
    Promise.reject(Object.assign(new Error('no links here'), { code: 'EPERM' }));

  it('falls back to an exclusive create and still never replaces', async () => {
    const path = join(dir, 'key');
    expect(await writeFileExclusive(path, 'first', noLinks)).toBe(true);
    expect(await writeFileExclusive(path, 'second', noLinks)).toBe(false);
    expect(await readFile(path, 'utf8')).toBe('first');
    expect((await readdir(dir)).sort()).toEqual(['key']);
  });

  it('does not hide an unrelated failure', async () => {
    const other = () => Promise.reject(Object.assign(new Error('disk on fire'), { code: 'EIO' }));
    await expect(writeFileExclusive(join(dir, 'key'), 'x', other)).rejects.toThrow('disk on fire');
  });
});

describe('private folders', () => {
  it.skipIf(process.platform === 'win32')(
    'tightens a folder that already existed to 0700',
    async () => {
      const existing = join(dir, 'config');
      await ensurePrivateDir(existing);
      await chmod(existing, 0o755);
      await ensurePrivateDir(existing);
      expect((await stat(existing)).mode & 0o777).toBe(0o700);
    },
  );
});
