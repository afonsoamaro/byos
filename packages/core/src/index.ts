export const PACKAGE_NAME = '@byos/core';

export {
  AuthError,
  ByosError,
  ConflictError,
  ERROR_CODES,
  NotFoundError,
  PermissionError,
  ProviderError,
  QuotaExceededError,
  RateLimitError,
  isByosError,
} from './errors.js';
export type { AuthReason, ByosErrorJson, ByosErrorOptions, ErrorCode } from './errors.js';
export type { ByosEvents, RequestEvent, RetryEvent, UploadProgressEvent } from './events.js';
export type { FileStat, ListResult } from './file-stat.js';
export type {
  CopyOptions,
  DeleteOptions,
  ListOptions,
  MkdirOptions,
  MoveOptions,
  PutBody,
  PutOptions,
  ResumableSession,
  StorageProvider,
} from './provider.js';
export type { FileRef } from './refs.js';
export { isRetryable, retry } from './retry.js';
export type { RetryOptions } from './retry.js';
export type { StoredToken, TokenStore } from './tokens.js';
