import {
  AuthError,
  ConflictError,
  NotFoundError,
  PermissionError,
  ProviderError,
  QuotaExceededError,
  RateLimitError,
  isByosError,
} from './errors.js';
import type { ByosEvents } from './events.js';

export interface RetryOptions {
  /** Total calls, counting the first. Default 5. */
  readonly maxAttempts?: number;
  /** Ceiling of the first backoff window. Default 500 ms. */
  readonly baseDelayMs?: number;
  /** Ceiling of any backoff window. Default 30 s. A server's `retryAfterMs` is not capped. */
  readonly maxDelayMs?: number;
  /** Source of jitter in [0, 1). Default `Math.random`. */
  readonly random?: () => number;
  /** Stops waiting and rejects with the signal's reason. */
  readonly signal?: AbortSignal;
  /** Name passed to `onRetry`. */
  readonly operation?: string;
  readonly onRetry?: ByosEvents['onRetry'];
}

/**
 * Whether retrying can help. Quota, auth, missing, conflicting and forbidden files fail the
 * same way every time, and an expired upload session must restart from zero instead.
 */
export function isRetryable(error: unknown): boolean {
  if (
    error instanceof QuotaExceededError ||
    error instanceof AuthError ||
    error instanceof NotFoundError ||
    error instanceof ConflictError ||
    error instanceof PermissionError
  ) {
    return false;
  }
  if (error instanceof ProviderError) return error.code !== 'UPLOAD_SESSION_EXPIRED';
  return true;
}

function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason as Error);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Calls `fn` until it succeeds, with exponential backoff and full jitter between attempts.
 * Gives up on a non-retryable error or after `maxAttempts`, rethrowing the error unchanged.
 */
export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = 5,
    baseDelayMs = 500,
    maxDelayMs = 30_000,
    random = Math.random,
    signal,
    operation,
    onRetry,
  } = options;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryable(error)) throw error;
      const window = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      let delayMs = random() * window;
      if (error instanceof RateLimitError && error.retryAfterMs !== undefined) {
        delayMs = Math.max(error.retryAfterMs, delayMs);
      }
      onRetry?.({
        ...(operation === undefined ? {} : { operation }),
        attempt,
        delayMs,
        ...(isByosError(error) ? { code: error.code } : {}),
      });
      await wait(delayMs, signal);
    }
  }
}
