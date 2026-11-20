/** An OAuth token as the consuming app stores it. Times are epoch milliseconds. */
export interface StoredToken {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt: number;
  /** Scopes Google granted, not the ones requested. */
  readonly scopes: readonly string[];
  /** When the user consented; kept across refreshes (Testing-mode expiry is 7 days from it). */
  readonly consentedAt: number;
}

/** Where tokens live is the consuming app's decision. */
export interface TokenStore {
  load(key: string): Promise<StoredToken | undefined>;
  save(key: string, token: StoredToken): Promise<void>;
  clear(key: string): Promise<void>;
}
