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

---

# Implementation Plan

## Prerequisites
- FN-00 done (workspace, Node-free guard in three layers, `pnpm check`). PP-02 done: `docs/cli-output.md` lists the error codes and exit codes this contract must match.
- Branch `feat/FN-01-core-contract` from an up-to-date `main`.
- Node 26 (`source ~/.nvm/nvm.sh && nvm use 26`).

## Reusable Code Found
- `packages/core/src/index.ts`: only `PACKAGE_NAME`, which `packages/drive/src/index.ts` imports. Keep `PACKAGE_NAME` exported so drive stays untouched.
- `packages/core/tsconfig.json`: `lib: ["es2024", "dom"]`, `types: []`. `ReadableStream`, `Blob`, `setTimeout` and `AbortSignal` come from the `dom` lib; there are no Node types in `src`.
- `packages/core/test/tsconfig.json`: tests get Node types and include `../src`, so `// @ts-expect-error` lines in tests are enforced by `pnpm typecheck`.
- `packages/core/test/index.test.ts`: the test style to copy (vitest, `describe` and `it`, imports from `../src/*.js`).
- `tests/portability.test.ts`: the browser-bundle guard over `packages/<pkg>/dist/index.js`. It gets a third entry for the new `testing` subpath.
- `eslint.config.mjs`: the `no-restricted-imports` Node guard already covers `packages/core/src/**`, the new `src/testing/` included.
- `scripts/cli-output-mock.ts`: its `ERROR_CODES` list is the PP-02 reference. The codes here must be exactly `NOT_FOUND`, `CONFLICT`, `PERMISSION_DENIED`, `AUTH_FAILED`, `RATE_LIMITED`, `QUOTA_EXCEEDED`, `UPLOAD_SESSION_EXPIRED` and `PROVIDER_ERROR`.

## Knowledge Registry
- Packages consumed through `dist` need `dist` built before type-aware lint and before another package's tests see a change. `pnpm check` already runs `build` first. When proving something by mutation across packages, rebuild after mutating.
- A full `vi.useFakeTimers()` is fine for `retry` because it is pure code with no I/O pool. Restore real timers in `afterEach`.
- Relative imports use the `.js` suffix (`module: nodenext`); the subpath export needs both `types` and `default`.

## Architecture Decisions
- **File layout in `packages/core/src/`:** `refs.ts` (`FileRef`), `file-stat.ts`, `provider.ts` (`StorageProvider` and option types), `errors.ts`, `tokens.ts` (`TokenStore`, `StoredToken`), `events.ts` (`ByosEvents`), `retry.ts`, `index.ts` (re-exports only), and `testing/memory-provider.ts` plus `testing/index.ts`.
- **`FileRef` is a discriminated union by exclusive keys:** `{ readonly id: string; readonly path?: never } | { readonly path: string; readonly id?: never }`. Passing both is a type error, which a test proves with `@ts-expect-error`.
- **`FileStat`:**
  - fields: `id`, `name`, `parents: readonly string[]`, `isFolder`, `size?: number` (bytes), `mimeType?`, `modifiedAt?: string` and `createdAt?: string` (RFC 3339), `md5?`, `sha256?` (lowercase hex), `appProperties: Readonly<Record<string, string>>`;
  - dates are strings, not `Date`, so a stat crosses `JSON.stringify` and the RN bridge unchanged, and it matches the CLI's JSON.
- **`StorageProvider` signatures.** Every method is `async`, and each one takes a single ref or options object:
  - `readonly name: string`;
  - `list(opts: { parent: FileRef; pageSize?: number; pageToken?: string }): Promise<ListResult>`, where `ListResult` is `{ items: FileStat[]; nextPageToken?: string }`;
  - `stat(ref: FileRef): Promise<FileStat | undefined>`, which returns `undefined` when the file doesn't exist or is trashed (FN-04's documented rule; every other method throws `NotFoundError`);
  - `get(ref: FileRef): Promise<ReadableStream<Uint8Array>>`;
  - `put(opts: PutOptions): Promise<FileStat>`;
  - `mkdir(opts: { parent: FileRef; name: string; parents?: boolean }): Promise<FileStat>`, idempotent: it returns the existing folder. `parents: true` creates missing segments when `parent` is a path;
  - `move(ref: FileRef, opts: { parent?: FileRef; name?: string }): Promise<FileStat>`, which needs at least one of the two;
  - `copy(ref: FileRef, opts: { parent: FileRef; name?: string }): Promise<FileStat>`;
  - `delete(ref: FileRef, opts?: { permanent?: boolean }): Promise<void>`, which trashes by default.
- **`PutOptions`:**
  - fields as in the issue: `parent`, `name`, `body: ReadableStream<Uint8Array> | Uint8Array | Blob`, `size?`, `mimeType?`, `sha256?`, `overwrite?` (default `false`), `appProperties?`, `onResumableSession?: (session: ResumableSession) => void | Promise<void>`;
  - `ResumableSession` is `{ uri: string; offset: number; size: number }`, a shape only. FN-06 owns the behavior and any resume input.
- **Errors (`errors.ts`):**
  - `ERROR_CODES` is an `as const` array of the 8 codes, and `ErrorCode` is its element type;
  - `abstract class ByosError extends Error` with `readonly code: ErrorCode`, the standard `cause` passed through `super(message, { cause })`, and `name` set to the class name;
  - subclasses: `NotFoundError`, `ConflictError`, `PermissionError`, `AuthError` (`readonly reason: AuthReason`, with the four reasons from the issue), `RateLimitError` (`readonly retryAfterMs?: number`), `QuotaExceededError`, and `ProviderError`. `ProviderError` takes `code?: 'PROVIDER_ERROR' | 'UPLOAD_SESSION_EXPIRED'` (default `PROVIDER_ERROR`) and wraps the rest;
  - **`toJSON()` returns only `{ name, code, message }`, plus `reason` and `retryAfterMs` when set.** Never `cause` and never `stack`: a `cause` may hold a `Response` or a request carrying a token, and FN-03 requires that `JSON.stringify(error)` can't leak one;
  - an `isByosError(value): value is ByosError` guard.
- **`retry` (`retry.ts`):**
  - signature: `retry<T>(fn: (attempt: number) => Promise<T>, opts?: RetryOptions): Promise<T>`;
  - `RetryOptions`:
    - `maxAttempts` (default 5, counting the first call);
    - `baseDelayMs` (default 500);
    - `maxDelayMs` (default 30_000);
    - `random` (default `Math.random`, injectable for tests);
    - `signal?: AbortSignal`, which stops waiting and rethrows `signal.reason`;
    - `onRetry?: ByosEvents['onRetry']`;
  - **full jitter:** the delay is `random() * min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1))`;
  - with a `RateLimitError` that has `retryAfterMs`, the delay is `max(retryAfterMs, jittered)`. `retryAfterMs` is not capped by `maxDelayMs`, because the server's wait wins;
  - `isRetryable(error)` is exported. It is false for `QuotaExceededError`, `AuthError`, `NotFoundError`, `ConflictError`, `PermissionError` and `ProviderError` with code `UPLOAD_SESSION_EXPIRED` (retrying an expired session can't succeed; FN-06 restarts from zero instead). It is true for everything else, including non-BYOS errors such as a network `TypeError` from `fetch`;
  - after the last attempt, or on a non-retryable error, it rethrows the error unchanged, with the same object identity;
  - waiting uses the global `setTimeout`, which exists in Node, the browser and RN.
- **Events (`events.ts`):** `ByosEvents` holds three optional callbacks, and no event carries a URL, header, token or session URI.
  - `onRequest(e: { operation: string; attempt: number })`;
  - `onRetry(e: { operation?: string; attempt: number; delayMs: number; code?: ErrorCode })`;
  - `onUploadProgress(e: { name: string; bytesConfirmed: number; totalBytes?: number })`.
- **Tokens (`tokens.ts`):**
  - `StoredToken` is `{ accessToken; refreshToken?; expiresAt: number (epoch ms); scopes: readonly string[]; consentedAt: number (epoch ms) }`;
  - `TokenStore` is `{ load(key): Promise<StoredToken | undefined>; save(key, token): Promise<void>; clear(key): Promise<void> }`.
- **`@byos/core/testing` ships in `dist`.**
  - `package.json` `exports` adds `"./testing": { "types": "./dist/testing/index.d.ts", "default": "./dist/testing/index.js" }`. Consumers (drive, cli, the future Expo app) use the fake in their own tests.
  - It is Node-free like the rest of `src`.
- **`MemoryProvider` (`testing/memory-provider.ts`):** `class MemoryProvider implements StorageProvider`, `name = 'memory'`, with a `Map<string, Entry>`, a root folder with id `root`, and sequential ids `mem-1`, `mem-2`, and so on.
  - **Paths:** `{ path }` refs resolve segment by segment from the root, ignoring trashed entries. A missing segment gives `NotFoundError`, and two live children with the same name give `ConflictError` (Drive allows duplicates; the fake mirrors FN-02's rule). Empty, `.` or `..` segments give `ProviderError`.
  - **`put`:** reads the body fully (`Uint8Array` as is, `Blob` through `arrayBuffer()`, `ReadableStream` through a reader loop) and stores the bytes. `overwrite: false` with a same-name live file in the parent gives `ConflictError`; `overwrite: true` replaces the bytes and keeps the id. `sha256` and `appProperties` are stored as given, and the fake does not compute hashes. `size` comes from the bytes. `modifiedAt`/`createdAt` come from an injectable `now()` (default `() => new Date().toISOString()`).
  - **`get`:** returns a `ReadableStream` over a copy of the bytes. On a folder it throws `ProviderError`.
  - **`list`:** returns live children sorted by name. `pageToken` is the stringified offset, and `nextPageToken` is set only when more remain. `pageSize` defaults to 100.
  - **`mkdir`:** idempotent. With `parents: true` and a path `parent`, it creates the missing segments; without it, a missing parent gives `NotFoundError`.
  - **`move`:** same-name conflict in the target gives `ConflictError`, and the id is kept.
  - **`copy`:** a folder gives `ProviderError`. A file gets a new id and keeps `sha256` and `appProperties`.
  - **`delete`:** sets `trashed` by default, which hides the entry from `stat`, `list` and path resolution. `permanent: true` removes the entry and its descendants.
  - **Failure injection for consumer tests:** `failNext(operation: keyof StorageProvider, error: Error)` makes the next call of that operation throw that error once.
  - **Introspection helpers:** `calls` is a per-operation counter (FN-13 asserts `delete` is never called), and `snapshot()` returns `{ id, path, isFolder, trashed }[]` for assertions.
- **No sync primitives:** no cursor, change, revision list or tombstone type.

## Files to Create
| File | Purpose |
|------|---------|
| `packages/core/src/refs.ts` | `FileRef` |
| `packages/core/src/file-stat.ts` | `FileStat`, `ListResult` |
| `packages/core/src/provider.ts` | `StorageProvider` and the option types, `ResumableSession` |
| `packages/core/src/errors.ts` | `ERROR_CODES`, `ErrorCode`, `AuthReason`, `ByosError` and subclasses, `isByosError` |
| `packages/core/src/tokens.ts` | `TokenStore`, `StoredToken` |
| `packages/core/src/events.ts` | `ByosEvents` and event payload types |
| `packages/core/src/retry.ts` | `retry`, `RetryOptions`, `isRetryable` |
| `packages/core/src/testing/memory-provider.ts` | `MemoryProvider` |
| `packages/core/src/testing/index.ts` | Re-exports `MemoryProvider` |
| `packages/core/test/errors.test.ts` | Codes, `instanceof`, `toJSON` without cause or stack, `ERROR_CODES` equals the PP-02 list |
| `packages/core/test/retry.test.ts` | Backoff, jitter, `retryAfterMs`, non-retryable, max attempts, abort |
| `packages/core/test/memory-provider.test.ts` | One `describe` per operation's contract, plus `FileRef` type tests |

Copy the style of `packages/core/test/index.test.ts` for the tests, and keep each `src` file to one concept, the way `packages/core/src/index.ts` is a single small module today.

## Files to Modify
| File | Changes |
|------|---------|
| `packages/core/src/index.ts` | Keep `PACKAGE_NAME`; add `export type` / `export` re-exports for every public symbol above, but not the testing module |
| `packages/core/package.json` | Add the `./testing` export |
| `tests/portability.test.ts` | Bundle `packages/core/dist/testing/index.js` too: add `'core/testing'` handling to the `it.each`, via an entry list `['core/index', 'core/testing/index', 'drive/index']` and `../packages/${pkg}.js` paths, keeping the "guard bites" case |
| `issues/FN-01-core-contract.md` | Execution Record at the end |
| `issues/_index.md` | FN-01 `todo` → `planned` now; `done` only by verify-it |

Do not touch `packages/drive/*`, `packages/cli/*` or `docs/cli-output.md`.

## Data Requirements
- Types only. No storage.

## Testing Strategy
- `errors.test.ts`:
  - each class's `code`, `name`, `instanceof ByosError` and `instanceof Error`;
  - `AuthError.reason` and `RateLimitError.retryAfterMs` are kept;
  - `ProviderError` defaults to `PROVIDER_ERROR` and accepts `UPLOAD_SESSION_EXPIRED`;
  - `JSON.stringify(new AuthError('expired', { reason: 'invalid-grant', cause: { token: 'secret-token' } }))` contains no `secret-token`, no `stack` and no `cause`;
  - `ERROR_CODES` equals the 8-code list from PP-02, in a literal array in the test.
- `retry.test.ts` uses `vi.useFakeTimers()` and `vi.advanceTimersByTimeAsync`, with `random: () => 1` for the maximum delay and `() => 0` for zero:
  - succeeds on the third attempt after two `ProviderError`s, with delays of 500 then 1000 at `random=1`;
  - `random=0.5` halves the delay;
  - the delay caps at `maxDelayMs`;
  - with `RateLimitError({ retryAfterMs: 5000 })`, it hasn't retried at 4999 ms and has at 5000 ms;
  - each non-retryable class (five classes plus `UPLOAD_SESSION_EXPIRED`) is called once and rethrown as the same object (`toBe`);
  - after `maxAttempts`, the last error is rethrown unchanged and `fn` was called `maxAttempts` times;
  - `onRetry` receives attempt, delay and code;
  - an abort during the wait rejects with the signal's reason;
  - a non-BYOS `TypeError` is retried.
- `memory-provider.test.ts`:
  - `const provider: StorageProvider = new MemoryProvider()` type-checks;
  - two `@ts-expect-error` lines, `{ id: 'a', path: 'b' }` as `FileRef` and `{}` as `FileRef`;
  - one `describe` per operation for its contract: `put` then `stat` and `get` round-trip for each of the three body kinds, the overwrite conflict and revision, `list` pagination over 3 items with `pageSize: 2`, idempotent `mkdir` with `parents`, a missing parent, a `move` conflict, a folder `copy` error, and `delete` with trash then `permanent`;
  - `stat` returns `undefined` for missing and trashed entries;
  - duplicate names on path resolution give `ConflictError`;
  - `failNext` throws once and then works;
  - the `calls` counter counts.
- Root `tests/portability.test.ts` bundles `core/testing` for the browser.
- Run every behavior once; no snapshot tests.

## Implementation Order
1. **Riskiest first, the subpath export.** Add `./testing` to `packages/core/package.json` and create `src/testing/index.ts` with a placeholder `export const TESTING = true;`. Update `tests/portability.test.ts`, then run:
   - `pnpm --filter @byos/core build`;
   - `ls packages/core/dist/testing/index.js packages/core/dist/testing/index.d.ts`;
   - `pnpm vitest run tests/portability.test.ts` from the root.
   If the subpath fails to build or bundle, stop and fix it before writing the contract.
2. Write the contract: `refs.ts`, `file-stat.ts`, `provider.ts`, `errors.ts`, `tokens.ts`, `events.ts`, and the re-exports in `index.ts`.
3. **Checkpoint:** run `pnpm check` once here, because the contract is fixed and every later package compiles against it.
4. Write `retry.ts`.
5. Write `MemoryProvider` and replace the placeholder in `testing/index.ts`.
6. Write the three test files.
7. `pnpm format`, then `pnpm check`.

## Security Considerations
- `ByosError.toJSON()` never serializes `cause` or `stack`. FN-03 and FN-06 rely on this so a token or session URI held in a `cause` can't leak through `JSON.stringify` or the CLI's `--json`.
- Event payloads carry no URL, header, token or session URI.
- `ResumableSession.uri` is bearer-like: a doc comment on the type says to persist it like a secret and never log it.

## Pattern to Copy
- `packages/core/test/index.test.ts` for the test file shape.
- `tests/portability.test.ts` for the bundle check (extend, don't duplicate).
- `scripts/cli-output-mock.ts` (`ERROR_CODES`) for the exact code list and order.

## Verification
- Command: `pnpm check` (build, lint, typecheck and tests green, including the three new core test files and the `core/testing` browser bundle).
- Command: `node -e "import('@byos/core/testing').then(m => console.log(typeof m.MemoryProvider))"` run from `packages/drive`, which prints `function`, proving the subpath resolves for a workspace consumer.
- Command: `grep -rn "node:" packages/core/src` (no output).

## Out of Scope
- `PathResolver` (FN-02), the Drive provider and its error mapping (FN-04 to FN-07), OAuth and the token manager (FN-03), and the CLI token store (FN-08).
- Resume input for uploads, chunking and hashing (FN-05 and FN-06).
- Any sync, cursor or change-feed type.
- A shared contract-test suite that the Drive provider also runs: tempting, but it belongs with FN-04 and FN-05 if it is wanted.
- Changes to `packages/drive` or `packages/cli`.

## Checkpoint
- `Checkpoint: sim`, after step 2 (contract types and errors fixed), before `retry` and the fake.

---

# Execution Record

- Branch `feat/FN-01-core-contract`, executed 2026-11-19.
- Step 1 (riskiest) passed on the first try: `./testing` built to `dist/testing/`, bundled for the browser in `tests/portability.test.ts` (entries `core/index`, `core/testing/index`, `drive/index`), and `import('@byos/core/testing')` from `packages/drive` resolves.
- Checkpoint after step 2 (types and errors): `pnpm check` green (build, lint, typecheck, 30 tests) before `retry` and the fake were written.
- Deviations from the plan:
  - `MemoryProvider` gained `allowDuplicateNames` (off by default). Without it the public API can't create two same-name items, so the "duplicate names refuse path resolution" rule couldn't be tested, and FN-02 needs the fake to produce duplicates the way Drive does.
  - `RetryOptions` also takes `operation`, passed through to `onRetry`, so a provider can label retries without wrapping the hook.
  - `stat` on a path that hits duplicate names rejects with `ConflictError` instead of resolving to `undefined`: only "does not exist" maps to `undefined`.
- Final `pnpm check`: build, lint (ESLint 0 warnings, Prettier clean), typecheck and tests green: 73 passed (44 in core, 2 in drive, 2 in cli, 25 in the root suite).
- `node -e "import('@byos/core/testing')..."` from `packages/drive` prints `function`; `grep -rn "node:" packages/core/src` prints nothing.
- Fixes after the independent verification (score 94, no vetoes), each with a test:
  - Error `name` is a literal per class instead of `new.target.name`, which a minifying consumer bundle (Expo, web) would rename.
  - `MemoryProvider.move` refuses to move a folder into its own subtree.
  - `delete(..., { permanent: true })` also removes an item that is already in the trash.
  - Cases were added for `move` with neither parent nor name, `put` with `overwrite` over a folder, and deleting the root.
- Undeclared deviation the verifier found, now recorded: the fake drops empty path segments instead of raising (`''` and `{ path: '' }` resolve to the root, and `a//b` is `a/b`). Only `.` and `..` raise. This matches FN-02's normalization rule ("leading/trailing slashes and repeated slashes are normalized").
- Final `pnpm check` after the fixes: green, 77 tests (48 in core, 2 in drive, 2 in cli, 25 in the root suite).
