# [FN-05] Drive provider: mkdir and simple upload

## Type
Functional

## Description
Write path for small files and folders: idempotent `mkdir` and `put` with a multipart upload up to 5 MiB, writing BYOS's SHA-256 into the file's `appProperties`.

## User Flow
1. Consumer calls `mkdir({ path: "Archive/2026-11", parents: true })` and gets the folder `FileStat`.
2. Consumer calls `put({ parent, name, body, sha256 })` and gets the new file's `FileStat`.

## Requirements
- `mkdir` with `parents: true` creates missing segments; returns the existing folder when the name already exists under the parent (idempotent). Concurrent `mkdir` calls for the same path in one provider instance are serialized (one creation, both callers get the same ID).
- `put` uses multipart upload when `size` is known and ≤ 5 MiB; larger or unknown size goes to the resumable path (FN-06; until then, throw a clear "not implemented" error).
- `appProperties.byosSha256` (lowercase hex) and `appProperties.byosVersion` are set on every upload. If the caller passes `sha256`, it is used; otherwise `put` computes it with Web Crypto while reading the body (for ≤ 5 MiB bodies).
- `overwrite: false` (default): if a non-trashed file with the same name exists in the parent, raise `ConflictError`. `overwrite: true`: upload a new revision of that file ID (`files.update` with media), keeping its ID.
- MIME type: caller's value, else derived from the extension with a small built-in table (jpg, jpeg, png, heic, heif, webp, gif, mp4, mov, pdf, json, txt), else `application/octet-stream`.

## Scenarios
### Happy Path
- `mkdir -p` of a 3-level path then `put` of a 200 KB JPEG returns a `FileStat` with `sha256` set.
### Edge Cases
- `mkdir` on a path where a segment exists as a file (not folder) raises `ConflictError`.
- Two parallel `mkdir` of the same path produce one folder.
### Error Handling
- `ConflictError` on existing name without `overwrite`.
- Quota exceeded during upload surfaces `QuotaExceededError`.

## Data Requirements
- `appProperties`: `byosSha256`, `byosVersion`.

## External Dependencies
- Drive API v3 `files.create` (folder and multipart media), `files.update` (media).

## Acceptance Criteria
- [ ] `mkdir` is idempotent and serialized per path (tested with parallel calls).
- [ ] Multipart upload sends correct metadata and `appProperties.byosSha256` (asserted on the request body).
- [ ] SHA-256 computed in `put` matches a known vector.
- [ ] `overwrite` false raises `ConflictError`; true keeps the same file ID.
- [ ] MIME fallback table tested.

## Dependencies
- FN-04.

---

# Implementation Plan

## Prerequisites
- FN-04 done: `DriveProvider` (read operations and write stubs), `DriveClient` (token, 401 once, retry, mapping), `api/files.ts`, `api/query.ts` and the Drive test fake (`test/drive/fake-drive.ts`, `test/drive/setup.ts`).
- `ProviderError.retryable` exists in core (FN-04): a rejected request is `retryable: false`.
- Branch `feat/FN-05-drive-write` from an up-to-date `main`.
- Node 26 in every shell (`source ~/.nvm/nvm.sh && nvm use 26`), background ones included.

## Reusable Code Found
- `packages/drive/src/drive-provider.ts`:
  - `#withRef(ref, fn)` resolves `{ id }` or `{ path }` through the resolver's `withPath`;
  - `#findChildren(parentId, name)` is the Drive name query, one request, returning `FileStat[]`;
  - `#statById` handles missing and trashed files;
  - the `put` and `mkdir` stubs get replaced here.
- `packages/drive/src/api/client.ts`: `DriveClient.json` (retry, 401 once, mapping, zod) and `#send`. They are extended, not duplicated (see Files to Modify).
- `packages/drive/src/api/files.ts`: `FILES_URL`, `FOLDER_MIME`, `FILE_FIELDS`, `driveFileSchema`, `filesUrl`, `toFileStat` (which already reads `byosSha256` from `appProperties`).
- `packages/drive/src/oauth/pkce.ts`: the `crypto.getRandomValues` usage pattern, reused for the multipart boundary.
- `packages/core/src/retry.ts`: `retry`, `isRetryable`; `ConflictError` is never retried.
- `packages/core/src/testing/memory-provider.ts`: the reference semantics.
  - `put` without `overwrite` raises `ConflictError` on a same-name file, and with `overwrite` keeps the id.
  - `mkdir` is idempotent, creates missing segments with `parents`, and refuses a file in the way.
- `packages/drive/test/drive/fake-drive.ts` and `setup.ts`: these are extended with write routes, not copied.

## Knowledge Registry
- **Fake `fetch` assertions:** return the fake without an `as typeof globalThis.fetch` assertion, which `no-unnecessary-type-assertion` rejects in `pnpm check`.
- **Absence tests** need a control.
- **Background shells start on Node 24.**

## Architecture Decisions
- **Endpoints:**
  - create a folder with `POST files?fields=<FILE_FIELDS>` and a JSON body `{ name, mimeType: FOLDER_MIME, parents: [parentId] }`;
  - create a file with `POST https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=<FILE_FIELDS>`;
  - add a new revision with `PATCH https://www.googleapis.com/upload/drive/v3/files/<id>?uploadType=multipart&fields=<FILE_FIELDS>`;
  - `UPLOAD_URL` goes into `api/files.ts`, next to `FILES_URL`, with an `uploadUrl(id | undefined, params)` helper mirroring `filesUrl`.
  - `[assumed]` These shapes come from the Drive v3 upload reference and are first exercised for real in FN-15 and FN-16.
- **Multipart body (`api/upload.ts`, `buildMultipart(metadata, bytes, mimeType)`):**
  - the result is a single `Uint8Array`: `--<b>\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n<json>\r\n--<b>\r\nContent-Type: <mime>\r\n\r\n<bytes>\r\n--<b>--`;
  - the content type is `multipart/related; boundary=<b>`;
  - the boundary is `byos-` plus 24 random hex characters from `crypto.getRandomValues`;
  - building it into bytes once makes the same body safe to resend on a retry.
- **Reading the body (`readBody(body, size?)` in `api/upload.ts`):**
  - a `Uint8Array` is used as is, a `Blob` through `arrayBuffer()`, and a `ReadableStream` through a reader loop;
  - the size limit is `SIMPLE_UPLOAD_LIMIT = 5 * 1024 * 1024`. When `size` is given and over the limit, or the size is unknown (a stream without `size`), it throws `ProviderError('files over 5 MiB or of unknown size need the resumable upload, which is not implemented yet', { retryable: false })` before reading;
  - a stream that delivers more bytes than the limit, or a byte count different from the given `size`, throws `ProviderError(..., { retryable: false })`.
- **SHA-256 (`sha256Hex(bytes)`):** `crypto.subtle.digest`, as lowercase hex. `put` always computes it over the bytes (≤ 5 MiB, cheap). If the caller passed `sha256` and it differs, `put` throws `ProviderError('the sha256 passed to put does not match the body', { retryable: false })`, which catches a wrong caller hash before it is stored as truth.
- **`appProperties`:** `{ ...caller appProperties, byosSha256, byosVersion: '1' }`.
  - `byosVersion` is the version of BYOS's metadata format (`BYOS_METADATA_VERSION = '1'` in `api/upload.ts`), not the package version.
  - The BYOS keys win over the caller's.
- **MIME (`api/mime.ts`, `mimeTypeFor(name)`):**
  - the caller's `mimeType` wins; otherwise the extension is looked up, lowercased, in a fixed table: `jpg`/`jpeg` → `image/jpeg`, `png`, `heic` → `image/heic`, `heif` → `image/heif`, `webp`, `gif`, `mp4` → `video/mp4`, `mov` → `video/quicktime`, `pdf` → `application/pdf`, `json` → `application/json`, `txt` → `text/plain`;
  - anything else, or no extension, gives `application/octet-stream`.
- **`DriveClient` gains a request body and a single-attempt mode.**
  - `json(operation, url, schema, init?)` and a new `jsonOnce(operation, url, schema, init?)`, with `init` as `{ method?: 'GET' | 'POST' | 'PATCH'; headers?: Record<string, string>; body?: Uint8Array | string }`.
  - `jsonOnce` makes one attempt with the 401 refresh but no `retry`. The provider uses it for creates, which need their own retry with reconciliation (below).
  - `#send` merges `init.headers` with `authorization` and passes `method` and `body`.
- **Creates aren't idempotent, so retries reconcile first.** A 5xx or a network failure after Drive already created the item would make a plain retry create a duplicate.
  - `#createWithReconcile(operation, parentId, name, create, matches)` runs `retry(async (attempt) => { if (attempt > 1) { const found = await this.#findChildren(parentId, name); const hit = found.find(matches); if (hit) return hit; } return create(); }, { operation, onRetry, ...retryOptions })`.
  - For `mkdir`, `matches` is `isFolder`. For `put`, it is `!isFolder && sha256 === ours`.
  - `overwrite` (`PATCH` on an existing id) is not reconciled: resending only adds another revision of the same content.
- **`mkdir({ parent, name, parents })`:**
  - with `parents: true` and a `{ path }` parent, it walks the segments from the root with `#ensureFolder` for each, then for `name`. Otherwise it resolves `parent` with `#withRef` (missing gives `NotFoundError`) and runs `#ensureFolder(parentId, name)`;
  - `#ensureFolder(parentId, name)` serializes per key: an in-flight `Map<string, Promise<FileStat>>` keyed by `` `${parentId}/${name}` `` makes concurrent callers share one promise, and the entry is deleted in `finally`. Inside, it calls `#findChildren`:
    - one folder found: return it (idempotent);
    - one file found: `ConflictError('<name> exists and is not a folder')`;
    - more than one: `ConflictError('more than one item named <name>')`;
    - none: create it through `#createWithReconcile`.
- **`put(options)`:**
  1. Resolve `parent` with `#withRef`.
  2. `readBody`, then `sha256Hex`, then check against `options.sha256`.
  3. Look up the existing child by name with `#findChildren`. A duplicate gives `ConflictError`. A folder with that name gives `ConflictError`. An existing file without `overwrite` gives `ConflictError('<name> already exists')`. An existing file with `overwrite` is replaced by `PATCH` through `json` (with retry), with metadata `{ appProperties, mimeType }`, keeping the id.
  4. Otherwise create through `#createWithReconcile`, with metadata `{ name, parents: [parentId], mimeType, appProperties }`.
  5. Fire `events.onUploadProgress?.({ name, bytesConfirmed: bytes.length, totalBytes: bytes.length })` once on success.
  6. Return `toFileStat` of the response.
  - `onResumableSession` is ignored here: a simple upload has no session.
- **No change to `retry` or the core contract.**

## Files to Create
| File | Purpose |
|------|---------|
| `packages/drive/src/api/upload.ts` | `SIMPLE_UPLOAD_LIMIT`, `BYOS_METADATA_VERSION`, `readBody`, `sha256Hex`, `buildMultipart` |
| `packages/drive/src/api/mime.ts` | `mimeTypeFor` |
| `packages/drive/test/drive/upload.test.ts` | Multipart builder, body reading limits, SHA-256 vector, MIME table |
| `packages/drive/test/drive/write-operations.test.ts` | `mkdir` and `put` against the fake |

## Files to Modify
| File | Changes |
|------|---------|
| `packages/drive/src/api/files.ts` | `UPLOAD_URL` and `uploadUrl()` |
| `packages/drive/src/api/client.ts` | `init` parameter on `json`, a new `jsonOnce`, and `#send` passing method, headers and body |
| `packages/drive/src/drive-provider.ts` | Real `mkdir` and `put`; `#ensureFolder` with the in-flight map; `#createWithReconcile`; the stubs for `move`, `copy` and `delete` stay |
| `packages/drive/src/index.ts` | Export `mimeTypeFor` |
| `packages/drive/test/drive/fake-drive.ts` | Write routes, the multipart parser, and `failAfterApply(match, reply)` (apply the request, then answer with a failure, to simulate a lost response) |
| `packages/drive/test/drive/read-operations.test.ts` | The "write operations are not implemented" case keeps only `move`/`copy`/`delete` |
| `issues/FN-05-drive-mkdir-and-put.md` | Execution Record |
| `issues/_index.md` | FN-05 `todo` → `planned` now; `done` only by verify-it |

### packages/drive/test/drive/fake-drive.ts
- The fake handles:
  - `POST /drive/v3/files`: parse the JSON body and create the folder (id `new-<n>`);
  - `POST /upload/drive/v3/files?uploadType=multipart`: split on the boundary from the `content-type`, `JSON.parse` the first part as metadata, keep the second part's bytes as `content` (store bytes as a `Uint8Array` on `FakeFile`, add a `bytes` field) and its `Content-Type` as `mimeType`, then create the file;
  - `PATCH /upload/drive/v3/files/<id>?uploadType=multipart`: replace content and `appProperties`, keeping the id.
- It records the raw body bytes on each `DriveRequest` (`body?: Uint8Array`), so the tests can assert on it.
- The fake reads `init.body` with `new Response(init.body).arrayBuffer()`, so `fetch` becomes async inside. Keep the outer signature, and return the fake without an `as` assertion.

## Data Requirements
- `appProperties`: `byosSha256` (lowercase hex SHA-256) and `byosVersion` (`'1'`).

## Testing Strategy
- `upload.test.ts`:
  - `sha256Hex` of `'abc'` is `ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad`, and of empty bytes is `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` (known vectors);
  - `buildMultipart` output, decoded, has the boundary in the content type, two parts in order, valid JSON metadata, and the exact bytes, including a binary byte `0xff`;
  - two builds use different boundaries;
  - `readBody` works for all three body kinds; stream without `size` and `size` over 5 MiB are refused before reading; a byte count that doesn't match `size` is refused;
  - `mimeTypeFor`: every row of the table, uppercase `IMG.JPG`, `archive.tar.gz` (octet-stream), and `README` (no extension).
- `write-operations.test.ts`:
  - `mkdir({ parent: { path: 'Documents' }, name: '2026-11', parents: true })` creates both levels, and a second identical call creates nothing new (count of `POST /files`);
  - **two parallel `mkdir` of the same path make exactly one folder** (one POST per level) and both get the same id;
  - `mkdir` where a segment is a file gives `ConflictError`; `mkdir` without `parents` under a missing parent gives `NotFoundError`;
  - `put` of a 200 KB "JPEG" (`new Uint8Array(200 * 1024).fill(7)`) into a fresh folder:
    - the recorded multipart metadata has `name`, `parents`, `mimeType: 'image/jpeg'`, and `appProperties.byosSha256` equal to `sha256Hex` of the bytes, with `byosVersion: '1'`;
    - the bytes part equals the input;
    - the returned `FileStat.sha256` is set;
  - `put` with a correct caller `sha256` succeeds, and with a wrong one gives `ProviderError` and sends no upload request;
  - `put` with an existing name and no `overwrite` gives `ConflictError` and sends no upload; with `overwrite: true` it sends a PATCH, keeps the id, and the content is replaced;
  - `put` with a name that is a folder gives `ConflictError`;
  - a 403 `storageQuotaExceeded` on the upload gives `QuotaExceededError`, with no retry;
  - **lost response:** `failAfterApply(/upload/, 503)` makes the create succeed in the fake but answer 503. The retry finds the file by name and hash, returns it, and the folder holds exactly one file with that name. The same holds for `mkdir`;
  - `onUploadProgress` fires once with the byte count.
- Every test file locks the global `fetch` with `vi.stubGlobal`. Use `retry: { random: () => 0 }` from `setup`.

## Implementation Order
1. **Riskiest first, multipart on the wire.** Write `api/upload.ts`, the client `init`/`jsonOnce` change and the fake's multipart route. Then write the "200 KB put asserts metadata and bytes" test and run it before anything else. A wrong boundary or CRLF is where the real Drive would reject everything later.
2. Write `#createWithReconcile` and the lost-response tests.
3. Write `mkdir` with `#ensureFolder` and the in-flight map, plus the parallel test.
4. Write the rest of `put` (overwrite, conflicts, sha check), `api/mime.ts`, and the remaining tests.
5. `pnpm format`, then `pnpm check`.

## Security Considerations
- The token stays in the `authorization` header only. The FN-04 hook and message tests keep covering the client, and the new operations reuse it.
- A caller-supplied `sha256` that doesn't match the body is refused, so a wrong hash can't be recorded as the file's identity, which backup and verify rely on.
- No delete or overwrite happens implicitly. `overwrite` must be explicit, and creates never replace.

## Pattern to Copy
- `packages/drive/src/drive-provider.ts` (FN-04) for the provider method style and `#withRef`.
- `packages/drive/test/drive/read-operations.test.ts` for the test layout with `setup()`.
- `packages/core/src/testing/memory-provider.ts` for the `mkdir` and `put` semantics.

## Verification
- Command: `pnpm check` (green, with the two new drive test files).
- Command: `grep -rn "node:\|console\." packages/drive/src` (no output).

## Out of Scope
- Resumable upload, files over 5 MiB, and `onResumableSession` (FN-06).
- `move`, `copy` and `delete` (FN-07).
- Computing SHA-256 incrementally while streaming. Web Crypto has no incremental digest, and that matters only for the resumable path.
- Any change to `packages/core` or `packages/cli`.

## Checkpoint
- `Checkpoint: nao`

---

# Execution Record

- Branch `feat/FN-05-drive-write`, executed 2026-11-20.
- Step 1 (riskiest): `DriveClient` gained a request `init` (method, headers, body) and `jsonOnce`. `api/upload.ts` builds the multipart body, and the fake parses it. The "200 KB put" test asserts the metadata (`name`, `parents`, `mimeType`, `appProperties.byosSha256`, `byosVersion: '1'`) and the exact bytes on the recorded request.
- TypeScript 6 with the `dom` lib requires `Uint8Array<ArrayBuffer>` for a `fetch` body and for `crypto.subtle.digest`. `readBody` now always returns a fresh `ArrayBuffer`-backed copy (at most 5 MiB), and the internal byte types say so.
- **The lost-response tests first passed without exercising anything.** Mutation (reconciliation switched off) showed it in three layers:
  - the fake matched injected failures against the full URL while the regexes anchored on the path;
  - once matched on path and query, the folder regex `files$` didn't match `/files?fields=...`;
  - `files\?` then matched the lookup `GET /files?q=...` first.
  - The fake now matches on path and query, and the folder failure targets `/files?fields=`. With reconciliation off, both lost-response tests fail; restored, all pass.
- Deviations from the plan:
  - A `Uint8Array` body over 5 MiB is refused before copying, like a `Blob`.
  - `put` compares a caller's `sha256` case-insensitively.
- `pnpm check`: build, lint (ESLint 0 warnings, Prettier clean), typecheck and tests green: 200 passed (69 in core, 104 in drive, 2 in cli, 25 in the root suite). `grep -rn "node:\|console\." packages/drive/src` prints nothing.
- After the independent verification (93, no vetoes):
  - The overwrite test also asserts that the PATCH metadata carries the new body's `byosSha256` and `byosVersion`.
  - The folder lost-response test asserts exactly one create request and an `onRetry` for `drive.mkdir`.
  - The plan's and tests' example folder is now `Documents` instead of the bill tracker's folder name.
- Final `pnpm check` after the fixes: green, 200 tests (69 in core, 104 in drive, 2 in cli, 25 in the root suite).
