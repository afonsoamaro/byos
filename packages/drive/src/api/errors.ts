import {
  NotFoundError,
  PermissionError,
  ProviderError,
  QuotaExceededError,
  RateLimitError,
  type ByosError,
} from '@byos/core';

// Messages use only the HTTP status and Drive's short `reason` (whitelisted). Never Drive's
// `error.message`, a URL, a query or a header.

const RATE_LIMIT = new Set(['userRateLimitExceeded', 'rateLimitExceeded']);
const PERMISSION = new Set([
  'insufficientPermissions',
  'appNotAuthorizedToFile',
  'insufficientFilePermissions',
]);

function reasonOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const error = (body as { error?: { errors?: { reason?: unknown }[] } }).error;
  const reason = error?.errors?.[0]?.reason;
  return typeof reason === 'string' && /^[A-Za-z]+$/.test(reason) ? reason : undefined;
}

/** `Retry-After` in seconds or as an HTTP date; undefined when absent or unreadable. */
export function parseRetryAfter(header: string | null, now: number): number | undefined {
  if (header === null) return undefined;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** Maps a non-2xx Drive response (other than the 401 the client handles) to a BYOS error. */
export function mapDriveError(
  status: number,
  body: unknown,
  headers: Headers,
  now: number,
): ByosError {
  const reason = reasonOf(body);
  if (status === 404) return new NotFoundError('not found in Google Drive');
  if (status === 429 || (status === 403 && reason !== undefined && RATE_LIMIT.has(reason))) {
    const retryAfterMs = parseRetryAfter(headers.get('retry-after'), now);
    return new RateLimitError(
      `Google Drive rate limit (${reason ?? `HTTP ${String(status)}`})`,
      retryAfterMs === undefined ? {} : { retryAfterMs },
    );
  }
  if (status === 403 && reason === 'accessNotConfigured') {
    return new ProviderError(
      'the Google Drive API is not enabled in this Google Cloud project (accessNotConfigured)',
      { retryable: false },
    );
  }
  if (status === 403 && reason === 'storageQuotaExceeded') {
    return new QuotaExceededError('your Google Drive is full');
  }
  if (status === 403 && reason !== undefined && PERMISSION.has(reason)) {
    return new PermissionError(`Google Drive refused access to this file (${reason})`);
  }
  if (status >= 500) {
    return new ProviderError(`Google Drive is unavailable (HTTP ${String(status)})`);
  }
  return new ProviderError(
    `Google Drive rejected the request (HTTP ${String(status)}, ${reason ?? 'no reason'})`,
    { retryable: false },
  );
}
