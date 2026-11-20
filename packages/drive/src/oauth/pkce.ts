// PKCE (RFC 7636) helpers on Web Crypto. Requires `crypto.getRandomValues` and
// `crypto.subtle.digest`: Node and browsers have both; React Native needs a polyfill.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Base64url without padding. Hand-written: `btoa` and `Buffer` are not reliable everywhere. */
export function base64url(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = bytes[index + 1] ?? 0;
    const c = bytes[index + 2] ?? 0;
    const triple = (a << 16) | (b << 8) | c;
    const chars = [18, 12, 6, 0].map((shift) => ALPHABET[(triple >> shift) & 63] ?? '');
    const keep = Math.min(4, Math.ceil(((bytes.length - index) * 8) / 6));
    out += chars.slice(0, keep).join('');
  }
  return out;
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

/** 32 random bytes as base64url: 43 characters, inside the 43–128 range PKCE requires. */
export function createCodeVerifier(): string {
  return base64url(randomBytes(32));
}

/** S256 challenge: base64url(SHA-256(verifier)). */
export async function codeChallengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export function createState(): string {
  return base64url(randomBytes(16));
}
