import { AuthError, ProviderError, type StoredToken } from '@byos/core';
import { z } from 'zod';

import { REVOKE_URL, TOKEN_URL } from './constants.js';
import { mapTokenError, networkError, type TokenErrorContext } from './errors.js';

type Fetch = typeof fetch;

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
  token_type: z.string(),
});

type TokenResponse = z.infer<typeof tokenResponseSchema>;

interface ClientOptions {
  readonly clientId: string;
  /** Desktop clients have one that Google treats as non-confidential; mobile clients have none. */
  readonly clientSecret?: string;
  readonly fetch?: Fetch;
  readonly now?: () => number;
}

export interface ExchangeCodeOptions extends ClientOptions {
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
}

export interface RefreshTokenOptions extends ClientOptions {
  readonly token: StoredToken;
}

async function post(
  url: string,
  params: Record<string, string>,
  fetchFn: Fetch,
): Promise<Response> {
  try {
    return await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
  } catch (error) {
    throw networkError(error);
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

async function requestToken(
  params: Record<string, string>,
  fetchFn: Fetch,
  context: TokenErrorContext,
): Promise<TokenResponse> {
  const response = await post(TOKEN_URL, params, fetchFn);
  const body = await readJson(response);
  if (!response.ok) throw mapTokenError(response.status, body, context);
  const parsed = tokenResponseSchema.safeParse(body);
  if (!parsed.success) throw new ProviderError('unexpected token response from Google');
  return parsed.data;
}

function clientParams(options: ClientOptions): Record<string, string> {
  return {
    client_id: options.clientId,
    ...(options.clientSecret === undefined ? {} : { client_secret: options.clientSecret }),
  };
}

const scopesOf = (response: TokenResponse): string[] | undefined =>
  response.scope?.split(' ').filter((scope) => scope !== '');

/**
 * Exchanges the authorization code for a token. `consentedAt` is now; scopes are the ones
 * Google granted, which can be fewer than requested.
 */
export async function exchangeCode(options: ExchangeCodeOptions): Promise<StoredToken> {
  const now = (options.now ?? Date.now)();
  const response = await requestToken(
    {
      ...clientParams(options),
      grant_type: 'authorization_code',
      code: options.code,
      code_verifier: options.codeVerifier,
      redirect_uri: options.redirectUri,
    },
    options.fetch ?? globalThis.fetch,
    { grant: 'authorization_code', now },
  );
  return {
    accessToken: response.access_token,
    ...(response.refresh_token === undefined ? {} : { refreshToken: response.refresh_token }),
    expiresAt: now + response.expires_in * 1000,
    scopes: scopesOf(response) ?? [],
    consentedAt: now,
  };
}

/** Refreshes the access token, keeping `consentedAt` and the refresh token when none is sent. */
export async function refreshToken(options: RefreshTokenOptions): Promise<StoredToken> {
  const { token } = options;
  if (token.refreshToken === undefined) {
    throw new AuthError('no refresh token stored; run the sign-in again', {
      reason: 'missing-token',
    });
  }
  const now = (options.now ?? Date.now)();
  const response = await requestToken(
    { ...clientParams(options), grant_type: 'refresh_token', refresh_token: token.refreshToken },
    options.fetch ?? globalThis.fetch,
    { grant: 'refresh_token', consentedAt: token.consentedAt, now },
  );
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token ?? token.refreshToken,
    expiresAt: now + response.expires_in * 1000,
    scopes: scopesOf(response) ?? token.scopes,
    consentedAt: token.consentedAt,
  };
}

/** Revokes a token (access or refresh) at Google. */
export async function revokeToken(options: { token: string; fetch?: Fetch }): Promise<void> {
  const response = await post(
    REVOKE_URL,
    { token: options.token },
    options.fetch ?? globalThis.fetch,
  );
  if (!response.ok)
    throw new ProviderError(`token revoke failed (HTTP ${String(response.status)})`);
}

/** On reconnect Google may send no refresh token: keep the one already stored. */
export function mergeReconnect(previous: StoredToken | undefined, fresh: StoredToken): StoredToken {
  if (fresh.refreshToken !== undefined || previous?.refreshToken === undefined) return fresh;
  return { ...fresh, refreshToken: previous.refreshToken };
}
