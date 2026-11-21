import { copyFile, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AuthError, ProviderError, type StoredToken } from '@byos/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileTokenStore } from '../../src/store/file-token-store.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'byos-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const token = (suffix = '1'): StoredToken => ({
  accessToken: `ACCESS-secret-${suffix}`,
  refreshToken: `REFRESH-secret-${suffix}`,
  expiresAt: 1_800_000_000_000,
  scopes: ['https://www.googleapis.com/auth/drive.file'],
  consentedAt: 1_790_000_000_000,
});

const keyOf = (byte: number) => Buffer.alloc(32, byte).toString('base64');
const store = (env: Record<string, string> = {}, extra: object = {}) =>
  new FileTokenStore({ configDir: dir, env, ...extra });

describe('round trip', () => {
  it('saves, loads and clears', async () => {
    const s = store();
    expect(await s.load('default')).toBeUndefined();
    await s.save('default', token());
    expect(await s.load('default')).toEqual(token());
    await s.clear('default');
    expect(await s.load('default')).toBeUndefined();
    await s.clear('default');
  });

  it('works with a key from the environment, and a second store reads the same file', async () => {
    const env = { BYOS_TOKEN_KEY: keyOf(7) };
    await store(env).save('default', token());
    expect(await store(env).load('default')).toEqual(token());
  });
});

describe('on disk', () => {
  it('holds no token text, neither plain nor as base64', async () => {
    const s = store({ BYOS_TOKEN_KEY: keyOf(1) });
    const t = token();
    await s.save('default', t);
    const raw = await readFile(join(dir, 'tokens', 'default.json'), 'utf8');
    for (const secret of [t.accessToken, t.refreshToken ?? '']) {
      expect(raw).not.toContain(secret);
      expect(raw).not.toContain(Buffer.from(secret).toString('base64'));
    }
    expect(JSON.parse(raw)).toMatchObject({ v: 1 });
    // Control: the token really is in there, and comes back.
    expect(await s.load('default')).toEqual(t);
  });

  it('uses a new IV on every write', async () => {
    const s = store({ BYOS_TOKEN_KEY: keyOf(1) });
    await s.save('default', token());
    const first = (
      JSON.parse(await readFile(join(dir, 'tokens', 'default.json'), 'utf8')) as { iv: string }
    ).iv;
    await s.save('default', token());
    const second = (
      JSON.parse(await readFile(join(dir, 'tokens', 'default.json'), 'utf8')) as { iv: string }
    ).iv;
    expect(first).not.toBe(second);
  });
});

describe('errors', () => {
  async function failure(work: Promise<unknown>): Promise<AuthError> {
    try {
      await work;
    } catch (error) {
      return error as AuthError;
    }
    throw new Error('expected a rejection');
  }

  it('a wrong key is an AuthError that says to sign in again, with no file contents', async () => {
    await store({ BYOS_TOKEN_KEY: keyOf(1) }).save('default', token());
    const error = await failure(store({ BYOS_TOKEN_KEY: keyOf(2) }).load('default'));
    expect(error).toBeInstanceOf(AuthError);
    expect(error.reason).toBe('missing-token');
    expect(error.message).toContain('byos auth');
    expect(error.cause).toBeUndefined();
    expect(`${error.message}${JSON.stringify(error)}${error.stack ?? ''}`).not.toMatch(
      /ACCESS|REFRESH|"ct"|"iv"/,
    );
  });

  it('a key that is not 32 bytes of base64 is an AuthError that never prints the key', async () => {
    const bad = 'not-a-real-key-value';
    const error = await failure(store({ BYOS_TOKEN_KEY: bad }).save('default', token()));
    expect(error).toBeInstanceOf(AuthError);
    expect(error.message).not.toContain(bad);
    const short = await failure(
      store({ BYOS_TOKEN_KEY: Buffer.alloc(16).toString('base64') }).save('default', token()),
    );
    expect(short).toBeInstanceOf(AuthError);
  });

  it.each([
    ['garbage', () => 'this is not json'],
    [
      'a flipped ciphertext byte',
      (raw: string) => {
        const envelope = JSON.parse(raw) as { ct: string };
        const bytes = Buffer.from(envelope.ct, 'base64');
        bytes[0] = (bytes[0] ?? 0) ^ 0xff;
        return JSON.stringify({ ...envelope, ct: bytes.toString('base64') });
      },
    ],
    [
      'an unknown version',
      (raw: string) => JSON.stringify({ ...(JSON.parse(raw) as object), v: 99 }),
    ],
  ])('a damaged file (%s) is an AuthError', async (_name, damage) => {
    const s = store({ BYOS_TOKEN_KEY: keyOf(1) });
    await s.save('default', token());
    const path = join(dir, 'tokens', 'default.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, damage(await readFile(path, 'utf8')));
    expect(await failure(s.load('default'))).toBeInstanceOf(AuthError);
  });

  it('a file copied to another key name does not open', async () => {
    const s = store({ BYOS_TOKEN_KEY: keyOf(1) });
    await s.save('first', token());
    await copyFile(join(dir, 'tokens', 'first.json'), join(dir, 'tokens', 'second.json'));
    expect(await failure(s.load('second'))).toBeInstanceOf(AuthError);
    expect(await s.load('first')).toEqual(token());
  });

  it.each(['../x', 'a/b', '..', '.', '', 'a\\b', 'x'.repeat(65)])(
    'refuses the key name %j',
    async (name) => {
      const s = store({ BYOS_TOKEN_KEY: keyOf(1) });
      await expect(s.save(name, token())).rejects.toBeInstanceOf(ProviderError);
      await expect(s.load(name)).rejects.toBeInstanceOf(ProviderError);
      expect(await readdir(dir)).toEqual([]);
    },
  );
});

describe('the key file', () => {
  it('is created on first use and reused', async () => {
    await store().save('default', token());
    const first = await readFile(join(dir, 'token.key'), 'utf8');
    expect(Buffer.from(first, 'base64')).toHaveLength(32);
    expect(await store().load('default')).toEqual(token());
    expect(await readFile(join(dir, 'token.key'), 'utf8')).toBe(first);
  });

  it('a damaged key file is an AuthError, never a silently new key', async () => {
    await store().save('default', token());
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'token.key'), 'short');
    await expect(store().load('default')).rejects.toBeInstanceOf(AuthError);
  });

  it('is not used when BYOS_TOKEN_KEY is set, and the env key never falls back to the file', async () => {
    await store().save('default', token());
    await expect(store({ BYOS_TOKEN_KEY: keyOf(9) }).load('default')).rejects.toBeInstanceOf(
      AuthError,
    );
  });
});

describe('permissions', () => {
  it.skipIf(process.platform === 'win32')('are owner-only on POSIX', async () => {
    await store().save('default', token());
    const mode = async (path: string) => (await stat(path)).mode & 0o777;
    expect(await mode(join(dir, 'token.key'))).toBe(0o600);
    expect(await mode(join(dir, 'tokens', 'default.json'))).toBe(0o600);
    expect(await mode(join(dir, 'tokens'))).toBe(0o700);
    expect(await mode(dir)).toBe(0o700);
  });
});
