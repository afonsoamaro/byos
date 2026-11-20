import { AuthError, ProviderError, type ByosError } from '@byos/core';

// Messages here are built only from constants, HTTP status codes, Google's short `error` code
// (whitelisted) and error class names. Never a URL, a request body or `error_description`,
// so no token, code, verifier or client secret can end up in a message.

const DAY_MS = 24 * 60 * 60 * 1000;
/** A refresh rejected this long after consent is likely the Testing-mode 7-day expiry. */
export const TESTING_MODE_WINDOW = { fromMs: 6.5 * DAY_MS, toMs: 8 * DAY_MS } as const;

export interface TokenErrorContext {
  readonly grant: 'authorization_code' | 'refresh_token';
  readonly consentedAt?: number;
  readonly now: number;
}

function shortCode(body: unknown): string {
  const error =
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>).error : undefined;
  return typeof error === 'string' && /^[a-z_]+$/.test(error) ? error : 'unknown_error';
}

/** Maps a non-2xx response of Google's token endpoint to a BYOS error. */
export function mapTokenError(
  status: number,
  body: unknown,
  context: TokenErrorContext,
): ByosError {
  if (status >= 500)
    return new ProviderError(`Google OAuth is unavailable (HTTP ${String(status)})`);
  const code = shortCode(body);
  if (code === 'invalid_grant') {
    if (context.grant === 'authorization_code') {
      return new AuthError(
        'the authorization code was rejected (expired, reused, or the verifier does not match); sign in again',
        { reason: 'invalid-grant' },
      );
    }
    const age = context.consentedAt === undefined ? undefined : context.now - context.consentedAt;
    if (age !== undefined && age >= TESTING_MODE_WINDOW.fromMs && age <= TESTING_MODE_WINDOW.toMs) {
      return new AuthError(
        'Google rejected the refresh token about 7 days after consent. If your OAuth consent screen is in Testing, Google expires refresh tokens after 7 days: publish the app (Google Cloud console › OAuth consent screen › Publish app), then sign in again.',
        { reason: 'testing-mode-expiry-suspected' },
      );
    }
    return new AuthError('Google rejected the refresh token (revoked or expired); sign in again.', {
      reason: 'invalid-grant',
    });
  }
  return new ProviderError(`Google OAuth rejected the request: ${code}`, { retryable: false });
}
