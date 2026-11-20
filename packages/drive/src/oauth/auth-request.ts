import { ProviderError } from '@byos/core';

import { AUTHORIZE_URL, DRIVE_SCOPES, type DriveScope } from './constants.js';
import { codeChallengeFor, createCodeVerifier, createState } from './pkce.js';

export interface AuthRequestOptions {
  readonly clientId: string;
  readonly redirectUri: string;
  /** Default `['drive.file']`. Only `drive.file` and `drive.appdata` are allowed. */
  readonly scopes?: readonly DriveScope[];
  /**
   * Ask Google to show the consent screen. Default `true`: without it a fresh connect gets no
   * refresh token. Pass `false` when the app already holds one.
   */
  readonly forceConsent?: boolean;
  readonly loginHint?: string;
}

export interface AuthRequest {
  /** Where to send the user. */
  readonly url: string;
  /** Keep it for `exchangeCode`; never log it. */
  readonly codeVerifier: string;
  /** Compare it with the `state` that comes back on the redirect, and reject a mismatch. */
  readonly state: string;
}

function isDriveScope(scope: string): scope is DriveScope {
  return Object.hasOwn(DRIVE_SCOPES, scope);
}

/** Builds the Google authorization URL with PKCE S256, a random state and offline access. */
export async function createAuthRequest(options: AuthRequestOptions): Promise<AuthRequest> {
  const scopes: readonly string[] = options.scopes ?? ['drive.file'];
  if (scopes.length === 0) throw new ProviderError('at least one scope is required');
  const urls = scopes.map((scope) => {
    if (!isDriveScope(scope)) {
      throw new ProviderError(
        `scope not allowed: ${scope}. BYOS requests only drive.file and drive.appdata`,
      );
    }
    return DRIVE_SCOPES[scope];
  });

  const codeVerifier = createCodeVerifier();
  const state = createState();
  const url = new URL(AUTHORIZE_URL);
  const params = url.searchParams;
  params.set('response_type', 'code');
  params.set('client_id', options.clientId);
  params.set('redirect_uri', options.redirectUri);
  params.set('scope', urls.join(' '));
  params.set('state', state);
  params.set('code_challenge', await codeChallengeFor(codeVerifier));
  params.set('code_challenge_method', 'S256');
  params.set('access_type', 'offline');
  if (options.forceConsent ?? true) params.set('prompt', 'consent');
  if (options.loginHint !== undefined) params.set('login_hint', options.loginHint);
  return { url: url.toString(), codeVerifier, state };
}
