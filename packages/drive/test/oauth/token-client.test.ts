import { AuthError, ProviderError, type StoredToken } from '@byos/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { exchangeCode, mergeReconnect, refreshToken, revokeToken } from '../../src/index.js';
import { DAY, fakeGoogle, tokenReply } from './fake-google.js';

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('real fetch called');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const NOW = Date.UTC(2026, 10, 20);
const now = () => NOW;

const stored = (consentedAt: number, extra: Partial<StoredToken> = {}): StoredToken => ({
  accessToken: 'old-access',
  refreshToken: 'refresh-1',
  expiresAt: NOW - 1000,
  scopes: ['https://www.googleapis.com/auth/drive.file'],
  consentedAt,
  ...extra,
});

describe('exchangeCode', () => {
  it('posts the code with the verifier and returns the granted token', async () => {
    const google = fakeGoogle([
      tokenReply('access-1', { refresh_token: 'refresh-1', expires_in: 3599 }),
    ]);
    const token = await exchangeCode({
      clientId: 'client',
      clientSecret: 'secret',
      code: 'code-1',
      codeVerifier: 'verifier-1',
      redirectUri: 'http://127.0.0.1:1/callback',
      fetch: google.fetch,
      now,
    });
    expect(google.requests[0]).toMatchObject({
      url: 'https://oauth2.googleapis.com/token',
      method: 'POST',
      body: {
        grant_type: 'authorization_code',
        code: 'code-1',
        code_verifier: 'verifier-1',
        redirect_uri: 'http://127.0.0.1:1/callback',
        client_id: 'client',
        client_secret: 'secret',
      },
    });
    expect(token).toEqual({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: NOW + 3599_000,
      scopes: ['https://www.googleapis.com/auth/drive.file'],
      consentedAt: NOW,
    });
  });

  it('sends no client_secret for a client without one', async () => {
    const google = fakeGoogle([tokenReply('access-1')]);
    await exchangeCode({
      clientId: 'client',
      code: 'c',
      codeVerifier: 'v',
      redirectUri: 'r',
      fetch: google.fetch,
      now,
    });
    expect(google.requests[0]?.body).not.toHaveProperty('client_secret');
  });

  it('records the scopes Google granted, not the ones requested', async () => {
    const google = fakeGoogle([tokenReply('a', { scope: 'openid' })]);
    const token = await exchangeCode({
      clientId: 'c',
      code: 'c',
      codeVerifier: 'v',
      redirectUri: 'r',
      fetch: google.fetch,
      now,
    });
    expect(token.scopes).toEqual(['openid']);
  });

  it('maps invalid_grant on exchange to AuthError invalid-grant', async () => {
    const google = fakeGoogle([{ status: 400, body: { error: 'invalid_grant' } }]);
    const attempt = exchangeCode({
      clientId: 'c',
      code: 'c',
      codeVerifier: 'v',
      redirectUri: 'r',
      fetch: google.fetch,
      now,
    });
    await expect(attempt).rejects.toMatchObject({ code: 'AUTH_FAILED', reason: 'invalid-grant' });
  });
});

describe('refreshToken', () => {
  it('keeps consentedAt and the refresh token when Google sends none', async () => {
    const google = fakeGoogle([tokenReply('access-2')]);
    const consentedAt = NOW - 2 * DAY;
    const token = await refreshToken({
      clientId: 'c',
      token: stored(consentedAt),
      fetch: google.fetch,
      now,
    });
    expect(google.requests[0]?.body).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-1',
    });
    expect(token).toMatchObject({
      accessToken: 'access-2',
      refreshToken: 'refresh-1',
      consentedAt,
      expiresAt: NOW + 3600_000,
    });
  });

  it('refuses to refresh without a refresh token', async () => {
    const google = fakeGoogle([]);
    await expect(
      refreshToken({
        clientId: 'c',
        token: { ...stored(NOW), refreshToken: undefined } as unknown as StoredToken,
        fetch: google.fetch,
        now,
      }),
    ).rejects.toMatchObject({ reason: 'missing-token' });
    expect(google.requests).toHaveLength(0);
  });

  it.each([
    [7 * DAY, 'testing-mode-expiry-suspected'],
    [6.5 * DAY, 'testing-mode-expiry-suspected'],
    [8 * DAY, 'testing-mode-expiry-suspected'],
    [6 * DAY, 'invalid-grant'],
    [30 * DAY, 'invalid-grant'],
  ])('maps invalid_grant at %i ms after consent to %s', async (age, reason) => {
    const google = fakeGoogle([{ status: 400, body: { error: 'invalid_grant' } }]);
    const attempt = refreshToken({
      clientId: 'c',
      token: stored(NOW - age),
      fetch: google.fetch,
      now,
    });
    await expect(attempt).rejects.toBeInstanceOf(AuthError);
    await expect(
      refreshToken({
        clientId: 'c',
        token: stored(NOW - age),
        fetch: fakeGoogle([{ status: 400, body: { error: 'invalid_grant' } }]).fetch,
        now,
      }),
    ).rejects.toMatchObject({ reason });
  });

  it('explains the Testing-mode fix in the message', async () => {
    const google = fakeGoogle([{ status: 400, body: { error: 'invalid_grant' } }]);
    await expect(
      refreshToken({ clientId: 'c', token: stored(NOW - 7 * DAY), fetch: google.fetch, now }),
    ).rejects.toThrow(/Testing.*publish the app/i);
  });

  it.each([
    [{ status: 401, body: { error: 'invalid_client' } }, /invalid_client/],
    [{ status: 400, body: { error: '<script>' } }, /unknown_error/],
    [{ status: 400, body: 'not json at all' }, /unknown_error/],
    [{ status: 503, body: {} }, /unavailable \(HTTP 503\)/],
    [{ status: 200, body: { token_type: 'Bearer' } }, /unexpected token response/],
  ])('maps %o to a ProviderError', async (reply, message) => {
    const google = fakeGoogle([reply]);
    const attempt = refreshToken({ clientId: 'c', token: stored(NOW), fetch: google.fetch, now });
    await expect(attempt).rejects.toBeInstanceOf(ProviderError);
    await expect(
      refreshToken({ clientId: 'c', token: stored(NOW), fetch: fakeGoogle([reply]).fetch, now }),
    ).rejects.toThrow(message);
  });

  it('turns a network failure into a ProviderError with no cause', async () => {
    const google = fakeGoogle([new TypeError('fetch failed')]);
    const error: unknown = await refreshToken({
      clientId: 'c',
      token: stored(NOW),
      fetch: google.fetch,
      now,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).cause).toBeUndefined();
    expect((error as ProviderError).message).toBe(
      'network error contacting Google OAuth (TypeError)',
    );
  });
});

describe('revokeToken', () => {
  it('posts the token to the revoke endpoint', async () => {
    const google = fakeGoogle([{ status: 200, body: {} }]);
    await revokeToken({ token: 'tok', fetch: google.fetch });
    expect(google.requests[0]).toMatchObject({
      url: 'https://oauth2.googleapis.com/revoke',
      body: { token: 'tok' },
    });
  });

  it('fails with a ProviderError on a non-200', async () => {
    const google = fakeGoogle([{ status: 400, body: { error: 'invalid_token' } }]);
    await expect(revokeToken({ token: 'tok', fetch: google.fetch })).rejects.toBeInstanceOf(
      ProviderError,
    );
  });
});

describe('mergeReconnect', () => {
  it('keeps the previous refresh token only when the fresh one lacks it', () => {
    const previous = stored(NOW - DAY);
    const withoutRefresh = { ...stored(NOW), refreshToken: undefined } as unknown as StoredToken;
    expect(mergeReconnect(previous, withoutRefresh).refreshToken).toBe('refresh-1');
    const withRefresh = stored(NOW, { refreshToken: 'refresh-2' });
    expect(mergeReconnect(previous, withRefresh).refreshToken).toBe('refresh-2');
    expect(mergeReconnect(undefined, withoutRefresh).refreshToken).toBeUndefined();
  });
});
