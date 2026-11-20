import type { StoredToken, TokenStore } from '@byos/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TokenManager, createAuthRequest, exchangeCode, refreshToken } from '../../src/index.js';
import { DAY, fakeGoogle, tokenReply } from './fake-google.js';

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('real fetch called');
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const NOW = Date.UTC(2026, 10, 20);

describe('secrets never leak', () => {
  it('keeps tokens, code, verifier and client secret out of errors, events and console', async () => {
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map(
      (method) => vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const events: unknown[] = [];
    const errors: unknown[] = [];
    const capture = async (work: Promise<unknown>) => {
      try {
        await work;
      } catch (error) {
        errors.push(error);
      }
    };

    const request = await createAuthRequest({
      clientId: 'client',
      redirectUri: 'http://127.0.0.1:1/cb',
    });
    const secrets = [
      'AT-secret-1',
      'RT-secret-1',
      'CODE-secret',
      'CS-secret',
      'AT-secret-2',
      request.codeVerifier,
    ];

    const token = await exchangeCode({
      clientId: 'client',
      clientSecret: 'CS-secret',
      code: 'CODE-secret',
      codeVerifier: request.codeVerifier,
      redirectUri: 'http://127.0.0.1:1/cb',
      fetch: fakeGoogle([tokenReply('AT-secret-1', { refresh_token: 'RT-secret-1' })]).fetch,
      now: () => NOW - 7 * DAY,
    });

    const saved = new Map<string, StoredToken>([['me', { ...token, expiresAt: NOW - 1 }]]);
    const store: TokenStore = {
      load: (key) => Promise.resolve(saved.get(key)),
      save: (key, value) => {
        saved.set(key, value);
        return Promise.resolve();
      },
      clear: (key) => {
        saved.delete(key);
        return Promise.resolve();
      },
    };
    const hooks = {
      onRequest: (event: unknown) => events.push(event),
      onRetry: (event: unknown) => events.push(event),
    };
    const manager = new TokenManager({
      store,
      key: 'me',
      clientId: 'client',
      clientSecret: 'CS-secret',
      fetch: fakeGoogle([{ status: 503, body: {} }, tokenReply('AT-secret-2')]).fetch,
      now: () => NOW,
      events: hooks,
      retry: { random: () => 0 },
    });
    expect(await manager.getAccessToken()).toBe('AT-secret-2');

    const failing = (fetch: typeof globalThis.fetch) =>
      refreshToken({
        clientId: 'client',
        clientSecret: 'CS-secret',
        token: { ...token, refreshToken: 'RT-secret-1' },
        fetch,
        now: () => NOW,
      });
    await capture(
      failing(
        fakeGoogle([
          {
            status: 400,
            body: { error: 'invalid_grant', error_description: 'RT-secret-1 is bad' },
          },
        ]).fetch,
      ),
    );
    await capture(
      failing(
        fakeGoogle([
          new TypeError(
            'fetch failed for https://oauth2.googleapis.com/token?refresh_token=RT-secret-1',
          ),
        ]).fetch,
      ),
    );
    await capture(
      failing(
        fakeGoogle([
          { status: 401, body: { error: 'invalid_client', error_description: 'CS-secret' } },
        ]).fetch,
      ),
    );

    // Control: the capture really saw errors and events, so the absence below means something.
    expect(errors.length).toBeGreaterThanOrEqual(3);
    expect(events.length).toBeGreaterThanOrEqual(2);

    const captured = [
      ...errors.flatMap((error) => {
        const e = error as Error;
        return [e.message, String(e), JSON.stringify(e), e.stack ?? ''];
      }),
      JSON.stringify(events),
    ].join('\n');
    for (const secret of secrets) expect(captured).not.toContain(secret);
    // A cause could hold a request; none of these errors carries one.
    for (const error of errors) expect((error as Error).cause).toBeUndefined();
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });
});
