import {
  AuthError,
  retry,
  type ByosEvents,
  type RetryOptions,
  type StoredToken,
  type TokenStore,
} from '@byos/core';

import { refreshToken } from './token-client.js';

export interface TokenManagerOptions {
  readonly store: TokenStore;
  /** Key the token is stored under. */
  readonly key: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly events?: ByosEvents;
  /** Overrides for the refresh retry (default 3 attempts). */
  readonly retry?: RetryOptions;
}

/** Refresh when the access token expires within this window. */
const REFRESH_MARGIN_MS = 60_000;

/**
 * Hands out a fresh access token. Refreshes ahead of expiry and once on a 401, writes the
 * refreshed token back to the store, and makes concurrent callers share one refresh.
 */
export class TokenManager {
  readonly #options: TokenManagerOptions;
  readonly #now: () => number;
  #token: StoredToken | undefined;
  #refreshing: Promise<StoredToken> | undefined;
  /** Bumped by `clear()`, so a refresh that finishes afterwards doesn't write the token back. */
  #generation = 0;

  constructor(options: TokenManagerOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  async getAccessToken(): Promise<string> {
    const token = await this.#current();
    if (token.expiresAt - this.#now() > REFRESH_MARGIN_MS) return token.accessToken;
    return (await this.#refresh(token)).accessToken;
  }

  /**
   * For the provider's single retry after a 401. If another caller already replaced the
   * rejected token, returns the current one without refreshing again.
   */
  async handleUnauthorized(rejectedAccessToken: string): Promise<string> {
    const token = await this.#current();
    if (this.#refreshing) return (await this.#refreshing).accessToken;
    if (token.accessToken !== rejectedAccessToken) return token.accessToken;
    return (await this.#refresh(token)).accessToken;
  }

  /** Forgets the token locally. Revoking it at Google is `revokeToken`, a separate call. */
  async clear(): Promise<void> {
    this.#generation += 1;
    this.#token = undefined;
    await this.#options.store.clear(this.#options.key);
  }

  async #current(): Promise<StoredToken> {
    if (!this.#token) {
      const generation = this.#generation;
      const loaded = await this.#options.store.load(this.#options.key);
      // A sign-out while the load was pending wins: don't resurrect the token.
      if (generation === this.#generation) this.#token ??= loaded;
    }
    if (!this.#token) {
      throw new AuthError('not signed in; run the sign-in first', { reason: 'missing-token' });
    }
    return this.#token;
  }

  #refresh(token: StoredToken): Promise<StoredToken> {
    this.#refreshing ??= this.#doRefresh(token).finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  async #doRefresh(token: StoredToken): Promise<StoredToken> {
    const { store, key, clientId, clientSecret, fetch, events } = this.#options;
    const generation = this.#generation;
    const refreshed = await retry(
      (attempt) => {
        events?.onRequest?.({ operation: 'oauth.refresh', attempt });
        return refreshToken({
          clientId,
          token,
          now: this.#now,
          ...(clientSecret === undefined ? {} : { clientSecret }),
          ...(fetch === undefined ? {} : { fetch }),
        });
      },
      {
        maxAttempts: 3,
        operation: 'oauth.refresh',
        ...(events?.onRetry === undefined ? {} : { onRetry: events.onRetry }),
        ...this.#options.retry,
      },
    );
    if (generation !== this.#generation) {
      throw new AuthError('signed out during a token refresh', { reason: 'missing-token' });
    }
    await store.save(key, refreshed);
    this.#token = refreshed;
    return refreshed;
  }
}
