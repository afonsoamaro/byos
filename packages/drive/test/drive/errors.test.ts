import {
  AuthError,
  NotFoundError,
  PermissionError,
  ProviderError,
  QuotaExceededError,
  RateLimitError,
} from '@byos/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { tokenReply } from '../oauth/fake-google.js';
import { driveError } from './fake-drive.js';
import { setup } from './setup.js';

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('real fetch called');
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const ROOT = /\/files\/root\?/;

async function caught(work: Promise<unknown>): Promise<Error> {
  try {
    await work;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a rejection');
}

describe('error mapping', () => {
  it('404 becomes NotFoundError', async () => {
    const { provider } = setup();
    await expect(provider.get({ id: 'nope' })).rejects.toBeInstanceOf(NotFoundError);
  });

  it.each(['userRateLimitExceeded', 'rateLimitExceeded'])(
    '403 %s becomes RateLimitError and is retried',
    async (reason) => {
      const { provider, drive } = setup();
      drive.failNext(ROOT, driveError(403, reason));
      await provider.list({ parent: { id: 'root' } });
      expect(drive.requests.filter((r) => ROOT.test(r.url.href))).toHaveLength(2);
    },
  );

  it('429 waits for Retry-After before retrying', async () => {
    vi.useFakeTimers();
    const { provider, drive } = setup();
    drive.failNext(ROOT, driveError(429, undefined, { 'retry-after': '2' }));
    const listing = provider.list({ parent: { id: 'root' } });
    await vi.advanceTimersByTimeAsync(1999);
    expect(drive.requests.filter((r) => ROOT.test(r.url.href))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(listing).resolves.toEqual({ items: [] });
    expect(drive.requests.filter((r) => ROOT.test(r.url.href))).toHaveLength(2);
  });

  it('403 rate limit gives up after the attempts with RateLimitError', async () => {
    const { provider, drive } = setup();
    drive.failNext(ROOT, ...Array.from({ length: 5 }, () => driveError(429)));
    await expect(provider.list({ parent: { id: 'root' } })).rejects.toBeInstanceOf(RateLimitError);
  });

  it('403 storageQuotaExceeded becomes QuotaExceededError and is not retried', async () => {
    const { provider, drive } = setup();
    drive.failNext(ROOT, driveError(403, 'storageQuotaExceeded'));
    await expect(provider.list({ parent: { id: 'root' } })).rejects.toBeInstanceOf(
      QuotaExceededError,
    );
    expect(drive.requests).toHaveLength(1);
  });

  it.each(['insufficientPermissions', 'appNotAuthorizedToFile'])(
    '403 %s becomes PermissionError',
    async (reason) => {
      const { provider, drive } = setup();
      drive.failNext(ROOT, driveError(403, reason));
      await expect(provider.list({ parent: { id: 'root' } })).rejects.toBeInstanceOf(
        PermissionError,
      );
      expect(drive.requests).toHaveLength(1);
    },
  );

  it('403 accessNotConfigured says the Drive API is not enabled, and is not retried', async () => {
    const { provider, drive } = setup();
    drive.failNext(ROOT, driveError(403, 'accessNotConfigured'));
    const error = await caught(provider.list({ parent: { id: 'root' } }));
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.message).toContain('not enabled in this Google Cloud project');
    expect(error.message).toContain('accessNotConfigured');
    expect(drive.requests).toHaveLength(1);
  });

  it('5xx is retried, then succeeds', async () => {
    const { provider, drive } = setup();
    drive.failNext(ROOT, driveError(503));
    await expect(provider.list({ parent: { id: 'root' } })).resolves.toEqual({ items: [] });
    expect(drive.requests.filter((r) => ROOT.test(r.url.href))).toHaveLength(2);
  });

  it('other 4xx becomes ProviderError', async () => {
    const { provider, drive } = setup();
    drive.failNext(ROOT, driveError(400, 'badRequest'));
    const error = await caught(provider.list({ parent: { id: 'root' } }));
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.message).toBe('Google Drive rejected the request (HTTP 400, badRequest)');
    expect(drive.requests).toHaveLength(1);
  });

  it('a network failure becomes ProviderError without a cause', async () => {
    const { provider, drive } = setup();
    drive.failNext(ROOT, ...Array.from({ length: 5 }, () => new TypeError('fetch failed')));
    const error = await caught(provider.list({ parent: { id: 'root' } }));
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.cause).toBeUndefined();
  });

  it('a malformed body becomes ProviderError', async () => {
    const { provider, drive } = setup();
    drive.failNext(ROOT, { status: 200, body: { id: 'root' } });
    await expect(provider.stat({ id: 'root' })).rejects.toThrow(/unexpected response/);
  });
});

describe('401', () => {
  it('refreshes once and repeats the request with the new token', async () => {
    const { provider, drive, google } = setup();
    drive.state.validToken = 'access-2';
    expect((await provider.stat({ id: 'root' }))?.name).toBe('My Drive');
    expect(google.requests).toHaveLength(1);
    const auths = drive.requests.map((r) => r.headers.authorization);
    expect(auths).toEqual(['Bearer access-1', 'Bearer access-2']);
  });

  it('a second 401 after the refresh becomes AuthError', async () => {
    const { provider, drive } = setup({ oauth: [tokenReply('access-3')] });
    drive.state.validToken = 'something-else';
    await expect(provider.list({ parent: { id: 'root' } })).rejects.toBeInstanceOf(AuthError);
  });
});

describe('messages', () => {
  it('never carry a URL, query, token or Drive detail', async () => {
    const { provider, drive } = setup();
    const errors: Error[] = [];
    drive.failNext(ROOT, driveError(403, 'storageQuotaExceeded'));
    errors.push(await caught(provider.list({ parent: { id: 'root' } })));
    drive.failNext(ROOT, driveError(400, 'invalidQuery'));
    errors.push(await caught(provider.list({ parent: { id: 'root' } })));
    errors.push(await caught(provider.get({ id: 'nope' })));
    const text = errors.map((e) => `${e.message}\n${JSON.stringify(e)}`).join('\n');
    expect(errors).toHaveLength(3);
    for (const error of errors) expect(error.cause).toBeUndefined();
    for (const forbidden of ['googleapis.com', 'access-1', 'q=', 'detail from Google']) {
      expect(text).not.toContain(forbidden);
    }
  });
});
