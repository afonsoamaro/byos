/** Stable codes, used by the CLI's `--json` output and by consumers to map messages. */
export const ERROR_CODES = [
  'NOT_FOUND',
  'CONFLICT',
  'PERMISSION_DENIED',
  'AUTH_FAILED',
  'RATE_LIMITED',
  'QUOTA_EXCEEDED',
  'UPLOAD_SESSION_EXPIRED',
  'PROVIDER_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type AuthReason =
  'invalid-grant' | 'testing-mode-expiry-suspected' | 'missing-token' | 'scope-missing';

export interface ByosErrorOptions {
  readonly cause?: unknown;
}

export interface ByosErrorJson {
  readonly name: string;
  readonly code: ErrorCode;
  readonly message: string;
  readonly reason?: AuthReason;
  readonly retryAfterMs?: number;
}

/**
 * Base of every BYOS error. `cause` may hold a response or request that carries a token, so
 * `toJSON` never serializes it, nor the stack.
 */
export abstract class ByosError extends Error {
  abstract readonly code: ErrorCode;
  // Literal per class, not `new.target.name`: a minified consumer bundle renames classes.
  abstract override readonly name: string;

  constructor(message: string, options: ByosErrorOptions = {}) {
    super(message, 'cause' in options ? { cause: options.cause } : undefined);
  }

  toJSON(): ByosErrorJson {
    return { name: this.name, code: this.code, message: this.message };
  }
}

export class NotFoundError extends ByosError {
  override readonly name = 'NotFoundError';
  readonly code = 'NOT_FOUND';
}

export class ConflictError extends ByosError {
  override readonly name = 'ConflictError';
  readonly code = 'CONFLICT';
}

export class PermissionError extends ByosError {
  override readonly name = 'PermissionError';
  readonly code = 'PERMISSION_DENIED';
}

export class AuthError extends ByosError {
  override readonly name = 'AuthError';
  readonly code = 'AUTH_FAILED';
  readonly reason: AuthReason;

  constructor(message: string, options: ByosErrorOptions & { readonly reason: AuthReason }) {
    super(message, options);
    this.reason = options.reason;
  }

  override toJSON(): ByosErrorJson {
    return { ...super.toJSON(), reason: this.reason };
  }
}

export class RateLimitError extends ByosError {
  override readonly name = 'RateLimitError';
  readonly code = 'RATE_LIMITED';
  readonly retryAfterMs: number | undefined;

  constructor(
    message: string,
    options: ByosErrorOptions & { readonly retryAfterMs?: number } = {},
  ) {
    super(message, options);
    this.retryAfterMs = options.retryAfterMs;
  }

  override toJSON(): ByosErrorJson {
    const json = super.toJSON();
    return this.retryAfterMs === undefined ? json : { ...json, retryAfterMs: this.retryAfterMs };
  }
}

export class QuotaExceededError extends ByosError {
  override readonly name = 'QuotaExceededError';
  readonly code = 'QUOTA_EXCEEDED';
}

/** Any other provider or network failure. Resumable upload uses `UPLOAD_SESSION_EXPIRED`. */
export class ProviderError extends ByosError {
  override readonly name = 'ProviderError';
  readonly code: 'PROVIDER_ERROR' | 'UPLOAD_SESSION_EXPIRED';

  constructor(
    message: string,
    options: ByosErrorOptions & {
      readonly code?: 'PROVIDER_ERROR' | 'UPLOAD_SESSION_EXPIRED';
    } = {},
  ) {
    super(message, options);
    this.code = options.code ?? 'PROVIDER_ERROR';
  }
}

export function isByosError(value: unknown): value is ByosError {
  return value instanceof ByosError;
}
