import { ProviderError } from '@byos/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAuthRequest } from '../../src/index.js';
import { base64url } from '../../src/oauth/pkce.js';

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('real fetch called');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const base = { clientId: 'client-123', redirectUri: 'http://127.0.0.1:53682/callback' };

describe('createAuthRequest', () => {
  it('builds a PKCE S256 URL with state, offline access and consent', async () => {
    const request = await createAuthRequest(base);
    const url = new URL(request.url);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const params = url.searchParams;
    expect(params.get('response_type')).toBe('code');
    expect(params.get('client_id')).toBe('client-123');
    expect(params.get('redirect_uri')).toBe(base.redirectUri);
    expect(params.get('scope')).toBe('https://www.googleapis.com/auth/drive.file');
    expect(params.get('state')).toBe(request.state);
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('access_type')).toBe('offline');
    expect(params.get('prompt')).toBe('consent');

    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(request.codeVerifier),
    );
    expect(params.get('code_challenge')).toBe(base64url(new Uint8Array(digest)));
  });

  it('makes a verifier PKCE accepts, and new values on every call', async () => {
    const first = await createAuthRequest(base);
    const second = await createAuthRequest(base);
    expect(first.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(second.codeVerifier).not.toBe(first.codeVerifier);
    expect(second.state).not.toBe(first.state);
  });

  it('omits prompt when consent is not forced, and passes a login hint', async () => {
    const url = new URL(
      (await createAuthRequest({ ...base, forceConsent: false, loginHint: 'owner@example.com' }))
        .url,
    );
    expect(url.searchParams.has('prompt')).toBe(false);
    expect(url.searchParams.get('login_hint')).toBe('owner@example.com');
  });

  it('accepts drive.file and drive.appdata together', async () => {
    const url = new URL(
      (await createAuthRequest({ ...base, scopes: ['drive.file', 'drive.appdata'] })).url,
    );
    expect(url.searchParams.get('scope')).toBe(
      'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.appdata',
    );
  });

  it.each([
    ['drive'],
    ['drive.readonly'],
    ['drive.metadata.readonly'],
    ['https://www.googleapis.com/auth/drive'],
  ])('refuses the %s scope', async (scope) => {
    await expect(
      createAuthRequest({ ...base, scopes: [scope as 'drive.file'] }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it('refuses an empty scope list', async () => {
    await expect(createAuthRequest({ ...base, scopes: [] })).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('base64url', () => {
  it('encodes without padding in the URL-safe alphabet', () => {
    expect(base64url(new Uint8Array([]))).toBe('');
    expect(base64url(new Uint8Array([0xfb, 0xff]))).toBe('-_8');
    expect(base64url(new TextEncoder().encode('hello'))).toBe('aGVsbG8');
  });
});
