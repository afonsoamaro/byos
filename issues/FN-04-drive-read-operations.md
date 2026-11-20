# [FN-04] Drive provider: list, stat, get and error mapping

## Type
Functional

## Description
First half of `DriveProvider`: read operations plus the request layer every operation shares (auth header, partial-response `fields`, retry, error mapping).

## User Flow
1. Consumer creates `new DriveProvider({ tokens, tokenStore, tokenKey, fetch?, hooks? })`.
2. Calls `list({ parent })`, `stat({ path })`, `get({ id })`.

## Requirements
- Request layer: bearer token from the FN-03 token manager, Drive REST v3 base URL, `fields` limited to what `FileStat` needs, `supportsAllDrives` not used (personal Drive only in v1).
- Error mapping: 404 → `NotFoundError`; 403 `userRateLimitExceeded`/`rateLimitExceeded` and 429 → `RateLimitError` (with `Retry-After`); 403 `storageQuotaExceeded` → `QuotaExceededError`; 403 `insufficientPermissions`/`appNotAuthorizedToFile` → `PermissionError`; 401 after one refresh → `AuthError`; 5xx → `ProviderError` (retryable); anything else → `ProviderError`.
- All calls go through core `retry`.
- `list`: children of a folder (`'<id>' in parents and trashed = false`), paginated with `pageSize` and `pageToken`; maps to `FileStat`.
- `stat`: by ID or path (via FN-02 resolver rooted at Drive `root` or a configured folder ID); returns `undefined` for not-found rather than throwing (documented).
- `get`: `alt=media` streaming download as `ReadableStream<Uint8Array>`; folders raise an error.
- `FileStat.sha256` comes from `appProperties.byosSha256`; `md5` from `md5Checksum`.
- Query strings escape names correctly (single quotes and backslashes in names).
- Event hooks fire for request and retry, without URLs that carry tokens and without headers.

## Scenarios
### Happy Path
- Listing a folder of 250 items over 3 pages returns all items in order.
### Edge Cases
- File name with `'` and `\` in a path lookup.
- Google Docs native files (no binary content): `get` raises a clear `ProviderError` saying export is not supported in v1.
### Error Handling
- 429 with `Retry-After: 2` waits and succeeds on retry.
- 403 `storageQuotaExceeded` is not retried.

## Data Requirements
- None.

## External Dependencies
- Google Drive API v3 (`files.list`, `files.get`). Tests use recorded fixture responses through an injected `fetch`.

## Acceptance Criteria
- [ ] `list`, `stat`, `get` work against fixture responses, including pagination and streaming.
- [ ] Every mapping in the error table has a test.
- [ ] Name escaping in queries is tested with `'` and `\`.
- [ ] Hook events contain no token or Authorization header (asserted).
- [ ] Zero Node built-in imports.

## Dependencies
- FN-02, FN-03.

---

# Implementation Plan

## Prerequisites
- FN-01, FN-02 and FN-03 done:
  - `StorageProvider`, `FileStat`, `retry`, `PathResolver` (with an injectable `findChildren` and `withPath`), and the error classes in `@byos/core`;
  - `TokenManager` (`getAccessToken`, `handleUnauthorized`) in `@byos/drive`;
  - zod 4.6.7 already a dependency of `@byos/drive`.
- Branch `feat/FN-04-drive-read` from an up-to-date `main`.
- Node 26 (`source ~/.nvm/nvm.sh && nvm use 26`, in every shell, background ones included).

## Reusable Code Found
- `packages/core/src/path-resolver.ts`: `new PathResolver(provider, { root, findChildren })`, plus `withPath(path, fn)` for "resolve, call, and retry once if a cached id is stale". Its class doc says a provider with a name query should inject its own `findChildren`; this issue does that.
- `packages/core/src/retry.ts`: `retry(fn, { operation, onRetry, ...})`, which already honors `RateLimitError.retryAfterMs` and never retries quota, auth, not-found, conflict or permission errors.
- `packages/drive/src/oauth/token-manager.ts`: `getAccessToken()`, and `handleUnauthorized(rejected)` for the single retry on a 401.
- `packages/drive/src/oauth/errors.ts`: `networkError(error)`, a `ProviderError` with no `cause`. This becomes its second use, so it moves to a shared module (see Files to Modify).
- `packages/drive/test/oauth/fake-google.ts`: the scripted-`fetch` pattern. The Drive fake copies its shape, but routes by URL instead of a queue.
- `packages/drive/test/oauth/no-secret-leak.test.ts`: the "control first, then absence" assertion style for the hook-events test.
- `packages/core/src/testing/memory-provider.ts`: the reference behavior for every read operation:
  - `stat` gives `undefined` for missing or trashed;
  - `get` on a folder gives `ProviderError`;
  - path ambiguity gives `ConflictError` (from the resolver).

## Knowledge Registry
- **Network tests:** the injected `fetch` returns `new Response(JSON.stringify(body), { status, headers })`. Lock the global `fetch` with `vi.stubGlobal` so nothing reaches the network.
- **Absence tests** (no token in hook events) need a control showing the capture saw events.
- **Background shells start on Node 24:** prefix every `pnpm check` with the nvm switch, including the ones run in the background.

## Architecture Decisions
- **Constructor:** `new DriveProvider({ tokens: TokenManager; fetch?: typeof fetch; events?: ByosEvents; root?: string /* default 'root' */; retry?: RetryOptions; cacheEntries?: number })`.
  - It takes the `TokenManager`, which the consumer builds with its `TokenStore` and key, instead of `tokenStore` and `tokenKey`. Building the manager stays in one place (FN-03) and the provider doesn't duplicate its options.
  - `name = 'google-drive'`.
- **Write operations** (`put`, `mkdir`, `move`, `copy`, `delete`) throw `ProviderError('<operation> is not implemented yet')` until FN-05 and FN-07. The class implements the full `StorageProvider` interface now.
- **Request layer:** `packages/drive/src/api/client.ts`, class `DriveClient`, constructed with `{ tokens, fetch, events, retry }`.
  - `json<T>(operation, url, schema)` and `stream(operation, url)` both run `retry(attempt => this.#send(...), { operation, onRetry: events.onRetry, ...retryOptions })`.
  - `#send` gets the token from `tokens.getAccessToken()` and fires `events.onRequest({ operation, attempt })`. It calls `fetch(url, { headers: { authorization: 'Bearer <token>' } })`.
  - On a 401 it calls `tokens.handleUnauthorized(token)` and repeats the request once with the new token. A second 401 throws `AuthError('Google Drive rejected the access token after a refresh; sign in again', { reason: 'invalid-grant' })`.
  - A non-2xx goes to `mapDriveError`, and a `fetch` rejection becomes `networkError(error, 'Google Drive')`.
  - JSON bodies are validated with the given zod schema; a mismatch throws `ProviderError('unexpected response from Google Drive (<operation>)')`.
  - Operation names are `drive.list`, `drive.stat`, `drive.get` and `drive.lookup`.
- **Error mapping** (`packages/drive/src/api/errors.ts`, `mapDriveError(status, body, headers, now)`):
  - The reason is `body.error.errors[0].reason`, accepted only if it matches `/^[A-Za-z]+$/`. Drive's `error.message` is never used.
  - 404 gives `NotFoundError('not found in Google Drive')`.
  - 429, or 403 with `userRateLimitExceeded` / `rateLimitExceeded`, gives `RateLimitError('Google Drive rate limit (<reason or HTTP 429>)', { retryAfterMs })`, which `retry` retries.
    - `retryAfterMs` comes from the `Retry-After` header: integer seconds × 1000, or an HTTP date minus `now`, clamped at ≥ 0. An absent or unparsable header leaves it unset.
  - 403 `storageQuotaExceeded` gives `QuotaExceededError('your Google Drive is full')`, which is not retried.
  - 403 `insufficientPermissions` / `appNotAuthorizedToFile` / `insufficientFilePermissions` gives `PermissionError('Google Drive refused access to this file (<reason>)')`.
  - 5xx gives `ProviderError('Google Drive is unavailable (HTTP <status>)')`, which is retried.
  - Anything else gives `ProviderError('Google Drive rejected the request (HTTP <status>, <reason>)')`.
  - No URL, query or header ever appears in a message.
- **Shared network error:** a new `packages/drive/src/http-errors.ts` exports `networkError(error: unknown, service: string): ProviderError`, with the message `network error contacting <service> (<error.name>)` and no `cause`. `oauth/token-client.ts` calls it with `'Google OAuth'`, so the existing message and test are unchanged, and the old function leaves `oauth/errors.ts`.
- **Fields and schemas** (`packages/drive/src/api/files.ts`):
  - `FILES_URL = 'https://www.googleapis.com/drive/v3/files'`, `FOLDER_MIME = 'application/vnd.google-apps.folder'`, and `FILE_FIELDS = 'id,name,parents,mimeType,size,modifiedTime,createdTime,md5Checksum,appProperties,trashed'`;
  - the zod `driveFileSchema` has `id` and `name` (strings), `parents` (string[], optional), `mimeType` (string), `size` (string, optional; Drive sends int64 as a string), `modifiedTime` and `createdTime` (string, optional), `md5Checksum` (optional), `appProperties` (string record, optional) and `trashed` (boolean, optional);
  - `listResponseSchema` is `{ files: driveFile[], nextPageToken?: string }`;
  - `toFileStat(file)`:
    - `isFolder` comes from `mimeType === FOLDER_MIME`, and `size` goes through `Number()` when present;
    - `md5` comes from `md5Checksum`, and `sha256` from `appProperties.byosSha256` when it matches `/^[0-9a-f]{64}$/`;
    - `appProperties` defaults to `{}`, and `parents` to `[]`.
- **Queries** (`packages/drive/src/api/query.ts`):
  - `escapeQueryValue(value)` doubles backslashes first, then backslash-escapes single quotes;
  - `childrenQuery(parentId)` returns `'<id>' in parents and trashed = false`;
  - `childByNameQuery(parentId, name)` returns `'<id>' in parents and name = '<escaped>' and trashed = false`;
  - ids are escaped too (defensive; Drive ids are `[A-Za-z0-9_-]`).
- **`list({ parent, pageSize, pageToken })`:**
  - it resolves `parent` to an id: a `{ path }` goes through the resolver with `withPath`, and the root is the configured root;
  - it sends `GET files?q=<childrenQuery>&fields=nextPageToken,files(<FILE_FIELDS>)&pageSize=<n, default 100, max 1000>&orderBy=folder,name_natural`, with `pageToken` when given;
  - it maps the files to `FileStat` and returns `{ items, nextPageToken? }`;
  - a parent that isn't found throws `NotFoundError` (not `undefined`: only `stat` has that rule).
- **`stat(ref)`:**
  - by id: `GET files/<id>?fields=<FILE_FIELDS>`, where a 404 or `trashed: true` gives `undefined`;
  - by path: `withPath(path, id => statById(id))`, where a resolver `NotFoundError` gives `undefined`, and `ConflictError` (duplicate names) and other errors propagate;
  - the empty path stats the root itself.
- **`get(ref)`:**
  - resolve the id, then `GET files/<id>?fields=id,mimeType`. A folder gives `ProviderError('<name> is a folder')`, and any other `application/vnd.google-apps.*` type gives `ProviderError('Google Docs, Sheets and Slides files cannot be downloaded in v1 (export is not supported)')`;
  - then `GET files/<id>?alt=media` and return `response.body`, or an empty stream if it is null. The metadata request comes first so these two errors stay clear;
  - the stream is not retried mid-way. `retry` covers only up to the response headers.
- **Resolver wiring:** the provider owns `new PathResolver(this, { root, maxEntries: cacheEntries, findChildren })`.
  - `findChildren(parentId, name)` runs `GET files?q=<childByNameQuery>&fields=files(<FILE_FIELDS>)&pageSize=10` (`drive.lookup`) and maps the results.
  - One request per path segment.
- **Hooks:** payloads are only the core's `{ operation, attempt }` and `{ operation, attempt, delayMs, code }`, with no URL, header or token, as the test asserts.
- `[assumed]` The response shapes are hand-written from the Drive v3 reference: the file resource, `files.list`, and the error body `{ error: { code, message, errors: [{ reason }] } }`. Real responses are first seen in the FN-15 and FN-16 smoke runs, where any shape mismatch shows up as the zod `ProviderError` above, not as silent wrong data.

## Files to Create
| File | Purpose |
|------|---------|
| `packages/drive/src/http-errors.ts` | Shared `networkError(error, service)` |
| `packages/drive/src/api/files.ts` | Endpoints, field list, zod schemas, `toFileStat` |
| `packages/drive/src/api/query.ts` | Query escaping and builders |
| `packages/drive/src/api/errors.ts` | `mapDriveError`, `parseRetryAfter` |
| `packages/drive/src/api/client.ts` | `DriveClient` (token, 401 once, retry, hooks, mapping) |
| `packages/drive/src/drive-provider.ts` | `DriveProvider` (read operations, resolver wiring, write stubs) |
| `packages/drive/test/drive/fake-drive.ts` | Routing fake `fetch` for Drive: in-memory files, records requests and headers, scripted failures |
| `packages/drive/test/drive/read-operations.test.ts` | `list`, `stat`, `get` |
| `packages/drive/test/drive/errors.test.ts` | Every row of the error table, 401 path, `Retry-After` |
| `packages/drive/test/drive/query.test.ts` | Escaping and the path lookup with `'` and `\` |
| `packages/drive/test/drive/hooks.test.ts` | Hook payloads carry no token or header |

## Files to Modify
| File | Changes |
|------|---------|
| `packages/drive/src/oauth/errors.ts` | Remove `networkError` (moved) |
| `packages/drive/src/oauth/token-client.ts` | Import `networkError` from `../http-errors.js` and call it with `'Google OAuth'` |
| `packages/drive/src/index.ts` | Export `DriveProvider`, `DriveProviderOptions`, `escapeQueryValue` |
| `issues/FN-04-drive-read-operations.md` | Execution Record |
| `issues/_index.md` | FN-04 `todo` → `planned` now; `done` only by verify-it |

Don't touch `packages/core` or `packages/cli`.

## Data Requirements
- None. `appProperties.byosSha256` is only read here; FN-05 writes it.

## Testing Strategy
- **`fake-drive.ts`:** `fakeDrive({ files?: FakeFile[] })` returns `{ fetch, requests, failNext(match: RegExp, replies: Reply[]) }`.
  - It parses the URL and serves the following routes:
    - `GET /drive/v3/files` with a `q`, where it interprets only the two query shapes the provider sends, `'<id>' in parents and trashed = false` and `... and name = '<escaped>' ...`, unescaping the value;
    - `GET /drive/v3/files/<id>` (metadata, with a 404 for unknown ids);
    - `GET /drive/v3/files/<id>?alt=media` (bytes).
  - It honors `pageSize` and `pageToken` (an offset string), and records `{ method, url, headers }`.
  - `failNext` queues replies (status, body and headers, or an `Error`) for the next request whose URL matches.
  - Every test file locks the global `fetch` with `vi.stubGlobal`.
- The tests build `TokenManager` with an in-memory `TokenStore` holding a fresh token, `access-1`. Its `fetch` is a second fake that serves `oauth2.googleapis.com/token` for the 401 test.
- `read-operations.test.ts`:
  - `list` of a folder with 250 files and `pageSize: 100` gives 3 pages, all 250 in order, and `nextPageToken` absent on the last page;
  - the request carries `fields`, `q` and `orderBy`;
  - `list({ parent: { path: 'a/b' } })` resolves and lists;
  - `stat` by id maps every field: `size` as a number, `md5`, `sha256` from `appProperties`, and the folder flag;
  - `stat` gives `undefined` for a 404 id, a trashed file and a missing path;
  - `stat` by path with duplicate names gives `ConflictError`;
  - a second `stat` by the same path makes 0 lookup requests (cache);
  - `get` streams the bytes, read back with `new Response(stream).text()`;
  - `get` on a folder and on a `application/vnd.google-apps.document` gives `ProviderError` with the export message;
  - write operations throw `ProviderError` "not implemented".
- `errors.test.ts`, one case per row:
  - 404 gives `NotFound`;
  - 429 with `Retry-After: 2` waits ≥ 2000 ms, checked with `vi.useFakeTimers()` and `advanceTimersByTimeAsync(1999)` showing no second request and then 1 ms more showing it, and then it succeeds;
  - 403 `userRateLimitExceeded` and `rateLimitExceeded` give `RateLimitError`;
  - 403 `storageQuotaExceeded` gives `QuotaExceededError` with exactly 1 request (not retried);
  - 403 `insufficientPermissions` and `appNotAuthorizedToFile` give `PermissionError`;
  - a 401 once refreshes via the token endpoint and succeeds, with the second request's `authorization` header carrying the new token;
  - a 401 twice gives `AuthError`;
  - a 503 then a 200 is retried;
  - a 400 gives `ProviderError`;
  - a network `TypeError` gives `ProviderError` with no cause;
  - a malformed 200 body gives `ProviderError`;
  - no message contains `googleapis.com`, `access-1` or `q=`.
  - Pass `retry: { random: () => 0 }` everywhere except the `Retry-After` test.
- `query.test.ts`:
  - `escapeQueryValue("it's")` gives `it\'s`, and `escapeQueryValue('a\\b')` gives `a\\\\b`;
  - `escapeQueryValue("\\'")` gives `\\\\\\'`;
  - a `stat({ path: "O'Brien\\notes/a.txt" })` sends a `q` whose decoded value is the escaped name, and it resolves.
- `hooks.test.ts`:
  - collect every `onRequest` and `onRetry` payload over a list, stat, get, 429 retry and 401 refresh;
  - control: at least 5 payloads;
  - assert that the JSON of all payloads has no `access-1`, `access-2`, `Bearer`, `authorization` or `googleapis.com`.

## Implementation Order
1. **Riskiest first, the request layer and the 401 and retry path.** Write `http-errors.ts` (and the oauth import change), `api/files.ts`, `api/errors.ts` and `api/client.ts`, a minimal `DriveProvider.stat` by id, and `fake-drive.ts`. Then run the `errors.test.ts` cases for 401 (once and twice), 429 with `Retry-After`, and quota-not-retried before going on. Token handling and retry interplay is where a loop or a double refresh would hide.
2. Write `api/query.ts` and the resolver wiring, then the rest of `stat`, `list` and `get`, and the write stubs.
3. Write the remaining tests.
4. Add the `index.ts` exports, `pnpm format`, then `pnpm check`.

## Security Considerations
- The access token appears only in the `authorization` request header. It never appears in errors, causes, hook payloads or logs, which `hooks.test.ts` and the message assertions in `errors.test.ts` check.
- Error messages drop Drive's `error.message` and every URL, query and header. The `reason` is whitelisted by regex.
- `drive.file` scope means Drive itself answers 403/404 for files the app didn't create. Those map to `PermissionError` and `NotFoundError`.

## Pattern to Copy
- `packages/drive/test/oauth/fake-google.ts` for the fake `fetch` shape.
- `packages/drive/src/oauth/token-client.ts` for zod at the boundary and the error-wrapping style.
- `packages/core/src/testing/memory-provider.ts` for the read-operation semantics.

## Verification
- Command: `pnpm check` (green, with the four new drive test files and the browser bundle of `drive/index`).
- Command: `grep -rn "node:\|console\." packages/drive/src` (no output).

## Out of Scope
- `mkdir`, `put` and resumable upload (FN-05, FN-06); `move`, `copy` and `delete` (FN-07).
- Export of Google Docs files, shared drives (`supportsAllDrives`), and the Changes API.
- The CLI (`byos ls`, `stat`, `get` are FN-11).
- Recording real Drive responses (FN-15, FN-16).

## Checkpoint
- `Checkpoint: nao`

---

# Execution Record

- Branch `feat/FN-04-drive-read`, executed 2026-11-20.
- **Owner decision during execution:** the core `retry` treated every `ProviderError` as transient, so a Drive 400 (a request rejected as such) was repeated up to 5 times; the first test run caught it. The owner chose an additive core change:
  - `ProviderError` gained `retryable` (default `true`, `false` for `UPLOAD_SESSION_EXPIRED`), and `isRetryable` reads it.
  - Drive maps other 4xx to `retryable: false`, and so does the OAuth token endpoint (`invalid_client` and the like), which the `TokenManager` used to retry 3 times.
  - Tests were added in core (errors, retry) and in drive (`invalid_client` not retried, a 400 sent once).
- Other deviations from the plan:
  - `list` checks the parent's metadata before listing, because Drive answers an empty list for a parent that doesn't exist. Not-found and not-a-folder errors are therefore clear, at one extra request.
  - The test setup lives in `test/drive/setup.ts` (token store, `TokenManager` with the OAuth fake, `DriveProvider` with the Drive fake), shared by the four test files.
- First final `pnpm check` failed on lint with one `no-unnecessary-type-assertion` in `test/drive/fake-drive.ts` (the same pattern as in FN-03). Removed; it is the same pattern that FN-03 hit.
- `pnpm check`: build, lint (ESLint 0 warnings, Prettier clean), typecheck and tests green: 168 passed (69 in core, 72 in drive, 2 in cli, 25 in the root suite). `grep -rn "node:\|console\." packages/drive/src packages/core/src` prints nothing.
- After the independent verification (93, no vetoes):
  - `SPECS.md` now lists `retryable` on `ProviderError`, since the core contract changed.
  - `list` clamps `pageSize` to 1..1000 and checks the parent's metadata only on the first page (no `pageToken`).
  - Tests: the 503 case asserts exactly 2 requests, and the message test also asserts every captured error has no `cause`.
- Final `pnpm check` after the fixes: green, 169 tests (69 in core, 73 in drive, 2 in cli, 25 in the root suite).
