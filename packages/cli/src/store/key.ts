import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { AuthError } from '@byos/core';

import { ensurePrivateDir, writeFileExclusive } from './atomic-write.js';

const KEY_BYTES = 32;

const unusable = (message: string) => new AuthError(message, { reason: 'missing-token' });

function decodeKey(text: string): Uint8Array<ArrayBuffer> | undefined {
  const trimmed = text.trim();
  const bytes = new Uint8Array(Buffer.from(trimmed, 'base64'));
  // Buffer is lenient with stray characters; the round trip makes it strict.
  return bytes.length === KEY_BYTES && Buffer.from(bytes).toString('base64') === trimmed
    ? bytes
    : undefined;
}

function toCryptoKey(bytes: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/**
 * The AES-256 key that seals tokens: `BYOS_TOKEN_KEY` (base64 of 32 bytes) when set, otherwise
 * a key file made on first use next to the tokens. The env var wins and never falls back to
 * the file, so a wrong value is an error, not a silent switch of key.
 */
export async function loadKey(options: {
  configDir: string;
  env: Readonly<Record<string, string | undefined>>;
}): Promise<CryptoKey> {
  const fromEnv = options.env.BYOS_TOKEN_KEY;
  if (fromEnv) {
    const bytes = decodeKey(fromEnv);
    if (!bytes) throw unusable('BYOS_TOKEN_KEY must be base64 of exactly 32 bytes');
    return toCryptoKey(bytes);
  }
  const file = join(options.configDir, 'token.key');
  await ensurePrivateDir(options.configDir);
  const fresh = Buffer.from(crypto.getRandomValues(new Uint8Array(KEY_BYTES))).toString('base64');
  // Two processes starting together converge on whichever file landed first.
  await writeFileExclusive(file, fresh);
  const bytes = decodeKey(await readFile(file, 'utf8'));
  if (!bytes) throw unusable('the token key file is damaged; remove it and run byos auth again');
  return toCryptoKey(bytes);
}
