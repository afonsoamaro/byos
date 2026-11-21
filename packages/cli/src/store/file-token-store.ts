import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { AuthError, ProviderError, type StoredToken, type TokenStore } from '@byos/core';

import { ensurePrivateDir, writeFileAtomic, type AtomicHooks } from './atomic-write.js';
import { loadKey } from './key.js';
import { tokensDir } from './paths.js';

const KEY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const VERSION = 1;

interface Envelope {
  readonly v: number;
  readonly iv: string;
  readonly ct: string;
}

const unreadable = () =>
  new AuthError(
    "the stored sign-in can't be read (wrong key or damaged file); run byos auth again",
    { reason: 'missing-token' },
  );

function isStoredToken(value: unknown): value is StoredToken {
  if (typeof value !== 'object' || value === null) return false;
  const token = value as Record<string, unknown>;
  return (
    typeof token.accessToken === 'string' &&
    typeof token.expiresAt === 'number' &&
    typeof token.consentedAt === 'number' &&
    Array.isArray(token.scopes) &&
    token.scopes.every((scope) => typeof scope === 'string') &&
    (token.refreshToken === undefined || typeof token.refreshToken === 'string')
  );
}

function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== 'object' || value === null) return false;
  const envelope = value as Record<string, unknown>;
  return (
    envelope.v === VERSION && typeof envelope.iv === 'string' && typeof envelope.ct === 'string'
  );
}

export interface FileTokenStoreOptions {
  readonly configDir: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Test hook: runs between writing the temp file and renaming it. */
  readonly atomicHooks?: AtomicHooks;
}

/**
 * Tokens on disk, one file per key under `<configDir>/tokens`, sealed with AES-256-GCM. The
 * key name is bound as additional data, so a file renamed to another key won't open.
 */
export class FileTokenStore implements TokenStore {
  readonly #configDir: string;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #hooks: AtomicHooks;
  #key: Promise<CryptoKey> | undefined;

  constructor(options: FileTokenStoreOptions) {
    this.#configDir = options.configDir;
    this.#env = options.env ?? process.env;
    this.#hooks = options.atomicHooks ?? {};
  }

  async load(key: string): Promise<StoredToken | undefined> {
    const path = this.#path(key);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const cryptoKey = await this.#cryptoKey();
    try {
      const envelope: unknown = JSON.parse(text);
      if (!isEnvelope(envelope)) throw new Error('not an envelope');
      const plain = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: new Uint8Array(Buffer.from(envelope.iv, 'base64')),
          additionalData: new TextEncoder().encode(key),
        },
        cryptoKey,
        new Uint8Array(Buffer.from(envelope.ct, 'base64')),
      );
      const token: unknown = JSON.parse(new TextDecoder().decode(plain));
      if (!isStoredToken(token)) throw new Error('not a token');
      return token;
    } catch {
      // Nothing from the file or the failure goes into the error: no contents, no cause.
      throw unreadable();
    }
  }

  async save(key: string, token: StoredToken): Promise<void> {
    const path = this.#path(key);
    const cryptoKey = await this.#cryptoKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(key) },
      cryptoKey,
      new TextEncoder().encode(JSON.stringify(token)),
    );
    const envelope: Envelope = {
      v: VERSION,
      iv: Buffer.from(iv).toString('base64'),
      ct: Buffer.from(sealed).toString('base64'),
    };
    await ensurePrivateDir(tokensDir(this.#configDir));
    await writeFileAtomic(path, JSON.stringify(envelope), this.#hooks);
  }

  async clear(key: string): Promise<void> {
    await rm(this.#path(key), { force: true });
  }

  #path(key: string): string {
    if (!KEY_NAME.test(key)) {
      throw new ProviderError('invalid token key name', { retryable: false });
    }
    return join(tokensDir(this.#configDir), `${key}.json`);
  }

  #cryptoKey(): Promise<CryptoKey> {
    this.#key ??= loadKey({ configDir: this.#configDir, env: this.#env });
    return this.#key;
  }
}
