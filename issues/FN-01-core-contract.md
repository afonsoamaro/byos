# [FN-01] Core contract: provider interface, types and errors

## Type
Functional

Checkpoint: sim (shared contract consumed by every other package and by the future Expo app)

## Description
Define `@byos/core`: the provider-agnostic contract every provider implements and every consumer depends on. This is the API surface BYOS is judged by, so it is small, ID-first, and runtime-agnostic.

## User Flow
1. A consumer imports types and errors from `@byos/core` and programs against `StorageProvider`, never against a concrete provider.

## Requirements
- `StorageProvider` with `name` and: `list`, `stat`, `get`, `put`, `mkdir`, `move`, `copy`, `delete`. Signatures take a `FileRef` that is either `{ id }` or `{ path }`; results always carry the provider file ID.
- `FileStat`: `id`, `name`, `parents`, `isFolder`, `size?`, `mimeType?`, `modifiedAt?`, `createdAt?`, `md5?` (provider-native), `sha256?` (BYOS-written), `appProperties`.
- `list` returns `{ items, nextPageToken? }` and takes `pageSize`, `pageToken`, a parent `FileRef`.
- `put` options: `parent: FileRef`, `name`, `body` (`ReadableStream<Uint8Array> | Uint8Array | Blob`), `size?`, `mimeType?`, `sha256?`, `overwrite?` (default `false`), `appProperties?`, and an `onResumableSession?` callback (shape only; behavior in FN-06).
- `get` returns `ReadableStream<Uint8Array>`.
- `delete` moves to trash by default; `permanent: true` deletes for good.
- Errors, each with a stable `code` used by CLI JSON output: `NotFoundError` (`NOT_FOUND`), `ConflictError` (`CONFLICT`), `PermissionError` (`PERMISSION_DENIED`), `AuthError` (`AUTH_FAILED`, with `reason`: `invalid-grant`, `testing-mode-expiry-suspected`, `missing-token`, `scope-missing`), `RateLimitError` (`RATE_LIMITED`, `retryAfterMs?`), `QuotaExceededError` (`QUOTA_EXCEEDED`), `ProviderError` (`PROVIDER_ERROR`, wraps the rest; resumable upload uses the specific code `UPLOAD_SESSION_EXPIRED`, see FN-06). A base `ByosError` with `code` and `cause`.
- `TokenStore` interface: `load(key)`, `save(key, token)`, `clear(key)`; `StoredToken` includes `accessToken`, `refreshToken?`, `expiresAt`, `scopes`, `consentedAt`.
- `retry(fn, opts)`: exponential backoff with full jitter, bounded attempts, honors `RateLimitError.retryAfterMs`, never retries `QuotaExceededError`, `AuthError`, `NotFoundError`, `ConflictError`, `PermissionError`.
- Optional event hook type: `onRequest`, `onRetry`, `onUploadProgress` (no telemetry dependency).
- **No sync primitives**: no cursor, change feed, or tombstone types. A test or lint check is not needed; reviewers reject them.
- Zero Node built-in imports (FN-00 guard).

## Scenarios
### Happy Path
- A fake in-memory provider in the test suite implements `StorageProvider` and type-checks.
### Edge Cases
- `FileRef` with both `id` and `path` is a type error (discriminated union).
- `retry` with `retryAfterMs` waits at least that long (fake timers).
### Error Handling
- `retry` gives up after `maxAttempts` and rethrows the last error unchanged.

## Data Requirements
- Types only.

## External Dependencies
- None at runtime.

## Acceptance Criteria
- [ ] `StorageProvider`, `FileRef`, `FileStat`, option types, `TokenStore`, `StoredToken` and the event hook are exported from `@byos/core`.
- [ ] Every error class has its `code` and is `instanceof ByosError`; codes match PP-02's mocks.
- [ ] An in-memory fake provider (in `core`'s test helpers, exported under a `testing` subpath) implements the interface and backs a test for each operation's contract.
- [ ] `retry` tests cover backoff, `retryAfterMs`, non-retryable errors and max attempts.
- [ ] `pnpm check` green; the Node-import guard still passes.

## Dependencies
- FN-00.
