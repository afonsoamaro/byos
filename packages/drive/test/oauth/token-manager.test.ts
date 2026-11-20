import { AuthError, type StoredToken, type TokenStore } from '@byos/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TokenManager } from '../../src/index.js';
import { DAY, fakeGoogle, tokenReply, type FakeReply } from './fake-google.js';

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('real fetch called');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const NOW = Date.UTC(2026, 10, 20);

class MemoryStore implements TokenStore {
  readonly tokens = new Map<string, StoredToken>();
  saves = 0;
  load(key: string) {
    return Promise.resolve(this.tokens.get(key));
  }
  save(key: string, token: StoredToken) {
    this.saves += 1;
    this.tokens.set(key, token);
    return Promise.resolve();
  }
  clear(key: string) {
    this.tokens.delete(key);
    return Promise.resolve();
  }
}

function setup(expiresIn: number, replies: FakeReply[] = []) {
  const store = new MemoryStore();
  store.tokens.set('me', {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: NOW + expiresIn,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
    consentedAt: NOW - DAY,
  });
  const google = fakeGoogle(replies);
  const onRetry = vi.fn();
  const manager = new TokenManager({
    store,
    key: 'me',
    clientId: 'client',
    fetch: google.fetch,
    now: () => NOW,
    events: { onRetry },
    retry: { random: () => 0 },
  });
  return { store, google, manager, onRetry };
}

describe('TokenManager', () => {
  it('returns a token that is still fresh without any request', async () => {
    const { google, manager } = setup(61_000);
    expect(await manager.getAccessToken()).toBe('access-1');
    expect(google.requests).toHaveLength(0);
  });

  it('refreshes within 60 s of expiry and saves the new token', async () => {
    const { store, google, manager } = setup(59_000, [tokenReply('access-2')]);
    expect(await manager.getAccessToken()).toBe('access-2');
    expect(google.requests).toHaveLength(1);
    expect(store.tokens.get('me')?.accessToken).toBe('access-2');
    expect(store.tokens.get('me')?.refreshToken).toBe('refresh-1');
  });

  it('shares one refresh among concurrent callers', async () => {
    const { store, google, manager } = setup(-1000, [tokenReply('access-2')]);
    const tokens = await Promise.all(Array.from({ length: 5 }, () => manager.getAccessToken()));
    expect(tokens).toEqual(Array(5).fill('access-2'));
    expect(google.requests).toHaveLength(1);
    expect(store.saves).toBe(1);
  });

  it('refreshes once on a 401 for the current token, not for a stale one', async () => {
    const { google, manager } = setup(3_600_000, [tokenReply('access-2')]);
    expect(await manager.handleUnauthorized('access-1')).toBe('access-2');
    expect(await manager.handleUnauthorized('access-1')).toBe('access-2');
    expect(google.requests).toHaveLength(1);
  });

  it("a 401 during another caller's refresh joins it instead of refreshing again", async () => {
    const { google, manager } = setup(-1000, [tokenReply('access-2')]);
    const first = manager.getAccessToken();
    const second = manager.handleUnauthorized('access-1');
    expect(await Promise.all([first, second])).toEqual(['access-2', 'access-2']);
    expect(google.requests).toHaveLength(1);
  });

  it('a sign-out during a refresh is not undone by the refresh finishing', async () => {
    const { store, manager } = setup(-1000, [tokenReply('access-2')]);
    const pending = manager.getAccessToken();
    await manager.clear();
    await expect(pending).rejects.toMatchObject({ reason: 'missing-token' });
    expect(store.tokens.size).toBe(0);
  });

  it('a sign-out while the refresh request is in flight discards its result', async () => {
    const store = new MemoryStore();
    store.tokens.set('me', {
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: NOW - 1000,
      scopes: [],
      consentedAt: NOW - DAY,
    });
    let reply: (response: Response) => void = () => undefined;
    let requested: () => void = () => undefined;
    const inFlight = new Promise<void>((resolve) => {
      requested = resolve;
    });
    const fetch = () =>
      new Promise<Response>((resolve) => {
        reply = resolve;
        requested();
      });
    const manager = new TokenManager({ store, key: 'me', clientId: 'c', fetch, now: () => NOW });
    const pending = manager.getAccessToken();
    await inFlight;
    await manager.clear();
    reply(new Response(JSON.stringify(tokenReply('access-2').body), { status: 200 }));
    await expect(pending).rejects.toMatchObject({ reason: 'missing-token' });
    expect(store.tokens.size).toBe(0);
  });

  it('retries a 503 and reports the retry', async () => {
    const { google, manager, onRetry } = setup(-1000, [
      { status: 503, body: {} },
      tokenReply('access-2'),
    ]);
    expect(await manager.getAccessToken()).toBe('access-2');
    expect(google.requests).toHaveLength(2);
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'oauth.refresh', attempt: 1, code: 'PROVIDER_ERROR' }),
    );
  });

  it('does not retry a client the token endpoint rejects', async () => {
    const { google, manager } = setup(-1000, [{ status: 401, body: { error: 'invalid_client' } }]);
    await expect(manager.getAccessToken()).rejects.toThrow(/invalid_client/);
    expect(google.requests).toHaveLength(1);
  });

  it('does not retry invalid_grant', async () => {
    const { google, manager } = setup(-1000, [{ status: 400, body: { error: 'invalid_grant' } }]);
    await expect(manager.getAccessToken()).rejects.toBeInstanceOf(AuthError);
    expect(google.requests).toHaveLength(1);
  });

  it('reports missing-token when nothing is stored, and clear empties the store', async () => {
    const { store, manager } = setup(3_600_000);
    await manager.clear();
    expect(store.tokens.size).toBe(0);
    await expect(manager.getAccessToken()).rejects.toMatchObject({ reason: 'missing-token' });
  });
});
