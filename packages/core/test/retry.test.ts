import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AuthError,
  ConflictError,
  NotFoundError,
  PermissionError,
  ProviderError,
  QuotaExceededError,
  RateLimitError,
  isRetryable,
  retry,
} from '../src/index.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** fn that fails with each given error in turn, then resolves to 'ok'. */
function failing(...errors: Error[]) {
  return vi.fn((_attempt: number) => {
    const error = errors.shift();
    return error ? Promise.reject(error) : Promise.resolve('ok');
  });
}

describe('retry', () => {
  it('backs off exponentially within full-jitter windows and then succeeds', async () => {
    const fn = failing(new ProviderError('a'), new ProviderError('b'));
    const delays: number[] = [];
    const result = retry(fn, { random: () => 1, onRetry: (e) => delays.push(e.delayMs) });

    await vi.advanceTimersByTimeAsync(499);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([500, 1000]);
  });

  it('scales the delay by the jitter source', async () => {
    const delays: number[] = [];
    const result = retry(failing(new ProviderError('a')), {
      random: () => 0.5,
      onRetry: (e) => delays.push(e.delayMs),
    });
    await vi.runAllTimersAsync();
    await expect(result).resolves.toBe('ok');
    expect(delays).toEqual([250]);
  });

  it('caps the window at maxDelayMs', async () => {
    const delays: number[] = [];
    const errors = Array.from({ length: 4 }, () => new ProviderError('x'));
    const result = retry(failing(...errors), {
      random: () => 1,
      baseDelayMs: 1000,
      maxDelayMs: 3000,
      onRetry: (e) => delays.push(e.delayMs),
    });
    await vi.runAllTimersAsync();
    await expect(result).resolves.toBe('ok');
    expect(delays).toEqual([1000, 2000, 3000, 3000]);
  });

  it('waits at least retryAfterMs, even above maxDelayMs', async () => {
    const fn = failing(new RateLimitError('slow down', { retryAfterMs: 5000 }));
    const result = retry(fn, { random: () => 0, maxDelayMs: 1000 });
    await vi.advanceTimersByTimeAsync(4999);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it.each([
    new QuotaExceededError('full'),
    new AuthError('expired', { reason: 'invalid-grant' }),
    new NotFoundError('gone'),
    new ConflictError('exists'),
    new PermissionError('forbidden'),
    new ProviderError('expired session', { code: 'UPLOAD_SESSION_EXPIRED' }),
  ])('does not retry %s and rethrows it unchanged', async (error) => {
    const fn = failing(error);
    await expect(retry(fn)).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(isRetryable(error)).toBe(false);
  });

  it('gives up after maxAttempts and rethrows the last error unchanged', async () => {
    const last = new ProviderError('third');
    const fn = failing(new ProviderError('first'), new ProviderError('second'), last);
    const result = retry(fn, { maxAttempts: 3, random: () => 0 });
    const assertion = expect(result).rejects.toBe(last);
    await vi.runAllTimersAsync();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('retries errors that are not BYOS errors, such as a network failure', async () => {
    const fn = failing(new TypeError('fetch failed'));
    const result = retry(fn, { random: () => 0 });
    await vi.runAllTimersAsync();
    await expect(result).resolves.toBe('ok');
    expect(isRetryable(new TypeError('x'))).toBe(true);
  });

  it('reports each retry with attempt, delay, code and operation', async () => {
    const onRetry = vi.fn();
    const result = retry(failing(new RateLimitError('x', { retryAfterMs: 100 })), {
      random: () => 0,
      operation: 'list',
      onRetry,
    });
    await vi.runAllTimersAsync();
    await result;
    expect(onRetry).toHaveBeenCalledWith({
      operation: 'list',
      attempt: 1,
      delayMs: 100,
      code: 'RATE_LIMITED',
    });
  });

  it('stops waiting when the signal aborts', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled');
    const fn = failing(new ProviderError('a'));
    const result = retry(fn, { random: () => 1, signal: controller.signal });
    const assertion = expect(result).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(100);
    controller.abort(reason);
    await assertion;
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
