# [FN-06] Drive provider: resumable upload

## Type
Functional

## Description
Large files (videos, big RAWs) upload through Drive's resumable protocol in chunks, and an upload interrupted by a crash or network loss continues from the last confirmed byte, even in a new process.

## User Flow
1. Consumer calls `put` with a body larger than 5 MiB (or unknown size).
2. The provider opens a resumable session and calls `onResumableSession({ sessionUri, offset })` after the session opens and after each confirmed chunk.
3. The process dies. On the next run, the consumer calls `resumeUpload({ sessionUri, body, size, sha256 })` with a body that starts at the confirmed offset.

## Requirements
- Session opened with metadata (name, parents, MIME, `appProperties.byosSha256`); SHA-256 must be provided by the caller for resumable uploads (computing it requires a full read, which the consumer already does).
- Chunk size a multiple of 256 KiB, default 8 MiB, configurable.
- After each chunk, the confirmed offset comes from Drive's `Range` response header, not from bytes sent.
- `resumeUpload` first asks Drive for the session's status (`Content-Range: bytes */<size>`), then sends from the confirmed offset.
- Session expired or not found (404/410) → `ProviderError` with code `UPLOAD_SESSION_EXPIRED`, so the consumer knows to restart from zero (code listed in FN-01).
- 5xx and network errors during a chunk retry that chunk with backoff; `onUploadProgress` reports bytes confirmed.
- **Security**: the session URI is a bearer-like secret (it accepts bytes without further auth for a while). It is passed only to `onResumableSession`, never logged or included in errors or hook events.

## Scenarios
### Happy Path
- A 50 MiB body uploads in 7 chunks; progress reaches 100 %; result `FileStat` has `sha256`.
### Edge Cases
- Body size exactly a multiple of the chunk size.
- Drive confirms fewer bytes than sent: next chunk starts from the confirmed offset.
### Error Handling
- Process restart mid-upload resumes from the confirmed offset (simulated with a fake server).
- Expired session raises the restart error.

## Data Requirements
- None in the library; the consumer persists `{ sessionUri, offset }`.

## External Dependencies
- Drive API v3 resumable upload (`uploadType=resumable`). Tests use a fake resumable server through injected `fetch`.

## Acceptance Criteria
- [ ] Chunked upload with 256 KiB-aligned chunks against a fake server.
- [ ] Offset taken from `Range`, with a test where the server confirms fewer bytes.
- [ ] `resumeUpload` resumes from status query result.
- [ ] Expired session yields the restart error code.
- [ ] Session URI never appears in errors, hooks or logs (asserted).

## Dependencies
- FN-05.

---

# Implementation Plan

## Prerequisites
- FN-05 done:
  - `DriveProvider.put` (simple multipart ≤ 5 MiB), `readBody`, `sha256Hex`, `buildMultipart`, `mimeTypeFor`;
  - `DriveClient` with `init` and `jsonOnce`, and the reconciling create;
  - the Drive fake with write routes and `failAfterApply` (matched on path and query).
- `ResumableSession` (`{ uri, offset, size }`) and `PutOptions.onResumableSession` already exist in the core contract (FN-01); `ProviderError` takes `code: 'UPLOAD_SESSION_EXPIRED'` and `retryable`.
- Branch `feat/FN-06-drive-resumable` from an up-to-date `main`.
- Node 26 in every shell, background ones included.

## Priorities
1. No corrupt or duplicated file: every byte sent starts at the offset Drive confirmed, and a lost final response never creates a second file.
2. The session URI stays secret: it never appears in errors, hook events or logs.
3. The acceptance criteria.
4. Bounded memory: at most one chunk buffered, never the whole file.

## Reusable Code Found
- `packages/drive/src/api/client.ts`: `DriveClient` (token, 401 once, `retry`, mapping, `jsonOnce`). It gains a raw single-attempt send (see below).
- `packages/drive/src/api/upload.ts`: `SIMPLE_UPLOAD_LIMIT`, `BYOS_METADATA_VERSION`, `readBody`, `sha256Hex`, `buildMultipart`.
- `packages/drive/src/api/mime.ts`: `mimeTypeFor`.
- `packages/drive/src/api/errors.ts`: `mapDriveError` (no URL in messages).
- `packages/drive/src/http-errors.ts`: `networkError(error, service)`, with no `cause`.
- `packages/drive/src/drive-provider.ts`:
  - `put` (existing-name check, overwrite, appProperties) and `#createWithReconcile`;
  - the file is ~320 lines and the multipart send appears twice, which the FN-05 verification flagged. This issue splits it before growing it.
- `packages/core/src/retry.ts`: `retry` with `onRetry`.
- `packages/drive/test/drive/fake-drive.ts` and `setup.ts`: extended with resumable routes.
- `packages/drive/test/oauth/no-secret-leak.test.ts` and `test/drive/hooks.test.ts`: the leak-test pattern, with a control first.

## Knowledge Registry
- **Injected failures** in the fake must be proved by mutation (switch off the mechanism, watch the test fail). Match the injection on what tells the request apart: method, or the first query parameter. A path prefix that another request shares isn't enough.
- **TS 6 with the `dom` lib** needs `Uint8Array<ArrayBuffer>` for a `fetch` body. Copy external bytes once at the edge.
- **Fake `fetch`:** return it without an `as typeof globalThis.fetch` assertion.
- **Absence tests** need a control.
- **Background shells start on Node 24.**

## Architecture Decisions
- **Protocol** (`packages/drive/src/api/resumable.ts`). `[assumed]` These shapes come from the Drive v3 resumable upload reference and are first exercised for real in FN-15 and FN-16.
  - **Open a session:**
    - `POST <UPLOAD_URL>?uploadType=resumable&fields=<FILE_FIELDS>`, or `PATCH <UPLOAD_URL>/<id>?...` for `overwrite`;
    - headers `content-type: application/json; charset=UTF-8`, `x-upload-content-type: <mime>` and `x-upload-content-length: <size>`;
    - the body is the JSON metadata, the same as the multipart metadata;
    - the session URI is the response's `Location` header, and a 2xx without `Location` is a `ProviderError`.
  - **Send a chunk:**
    - `PUT <sessionUri>` with `content-range: bytes <start>-<end>/<size>` and the chunk bytes;
    - a `308` means incomplete. The confirmed offset is `Range: bytes=0-<n>`, giving `n + 1`, and a 308 without `Range` means 0 confirmed;
    - a `200` or `201` means complete, and the body is the file resource.
  - **Query status:** `PUT <sessionUri>` with an empty body and `content-range: bytes */<size>`, answered the same way (308 with `Range`, or 200/201 with the resource).
  - **Expired:** a `404` or `410` from any session request throws `ProviderError('the upload session expired; start the upload again', { code: 'UPLOAD_SESSION_EXPIRED' })`. `retryable` is already false for that code.
  - Any other non-2xx/308 goes through `mapDriveError`. A `fetch` rejection goes through `networkError(error, 'Google Drive')`, with no cause.
  - Session requests carry the bearer token like every other Drive request (`[assumed]` harmless if Drive doesn't need it), via the client.
- **`DriveClient.rawOnce(operation, url, init)`:** one attempt with the 401 refresh, but **no** status mapping and no `retry`. It returns the `Response` for the caller to interpret (308 is not an error here). `onRequest` fires as usual.
  - The URL passed is the session URI. The client never puts URLs in errors or events, which the tests check.
- **The confirmed offset is the only source of truth.** After every chunk, the next chunk starts at Drive's confirmed offset, even when it is lower than the bytes sent.
  - Only one chunk is buffered.
  - If Drive confirms less than the buffered chunk, the unsent tail of that chunk is resent from the buffer. The confirmed offset can never fall below the chunk's start, because Drive's offsets only grow.
  - If a status answer goes backwards (below the chunk start), that is a `ProviderError('Google Drive reported an upload offset that went backwards', { retryable: false })`.
- **Chunk reading:** `chunks(body, chunkSize)` is an async generator over a `PutBody` that yields `Uint8Array<ArrayBuffer>` slices of exactly `chunkSize` (the last one shorter).
  - It reads a `Blob` by `slice()` and a `ReadableStream` by accumulating reads. A `Uint8Array` is sliced with a copy, so that only `chunkSize` bytes are held at a time.
  - If the body ends before `size` or runs past it, it throws `ProviderError(..., { retryable: false })`.
- **Retries per chunk:**
  - each chunk send runs in `retry(async (attempt) => { if (attempt > 1) offset = await status(); /* send buffer from offset */ }, { operation: 'drive.upload', onRetry, ...retryOptions })`;
  - 5xx and network errors are retried; a 4xx other than 404/410, and an expired session, are not;
  - **a lost final response** (Drive completed, the answer failed) is caught by the status query on the next attempt, which answers 200/201 with the resource and finishes without a new file.
- **`chunkSize`:** a new `DriveProviderOptions.chunkSize`, default `8 * 1024 * 1024`. The constructor throws `ProviderError('chunkSize must be a positive multiple of 256 KiB', { retryable: false })` otherwise.
- **`put` routing:**
  - `size ≤ SIMPLE_UPLOAD_LIMIT` and known: the simple multipart (FN-05, unchanged behavior);
  - `size > 5 MiB`, or a `Blob` or `Uint8Array` body over 5 MiB: resumable;
  - **unknown size:** `ProviderError('the size is required for uploads over 5 MiB', { retryable: false })`. The issue allowed an unknown size, but every v1 consumer (the CLI, backup) uploads files whose size it knows, and Drive's unknown-length protocol adds a final-chunk handshake for nothing.
  - **Resumable requires `sha256`**, since a full read just to hash would defeat streaming. A missing hash gives `ProviderError('sha256 is required for uploads over 5 MiB', { retryable: false })`. The hash is trusted, not recomputed, and is written to `appProperties.byosSha256` (normalized to lowercase). After completion, the returned resource's `byosSha256` must equal it, or it is a `ProviderError`.
  - The existing-name, `ConflictError` and `overwrite` rules are the same as the simple path: they are decided once, before choosing the path.
- **Callbacks:**
  - `onResumableSession({ uri, offset, size })` is called once after opening (offset 0) and after every chunk that advanced the confirmed offset. It is awaited, so the consumer has persisted it before the next chunk.
  - `events.onUploadProgress({ name, bytesConfirmed, totalBytes: size })` fires after every confirmed advance. Its payload has no URI.
- **`resumeUpload`:** a new public method on `DriveProvider`, not in the core `StorageProvider` contract, since resuming is Drive-specific in v1.
  - Signature: `resumeUpload(options: { session: ResumableSession; name: string; sha256: string; openAt: (offset: number) => PutBody | Promise<PutBody>; onResumableSession?: ... }): Promise<FileStat>`.
  - It first queries the status. A completed upload returns the resource right away; an expired session throws `UPLOAD_SESSION_EXPIRED`.
  - Otherwise it calls `openAt(confirmedOffset)` and streams from there.
  - **`openAt` replaces "a body that starts at the confirmed offset" from the issue text.** The offset Drive reports can be ahead of the last one the consumer persisted (the process died after Drive confirmed but before the callback finished), and only the provider learns the real one. The consumer opens its file at whatever offset it is given.
- **Splitting `drive-provider.ts`:**
  - the multipart send moves to `packages/drive/src/api/simple-upload.ts` as `simpleUpload(client, { existingId?, parentId, name, bytes, mimeType, appProperties })`, a single place for both POST and PATCH that removes the duplication;
  - the resumable flow lives in `packages/drive/src/api/resumable.ts` as `resumableUpload(client, {...})` and `resumeSession(client, {...})`;
  - `DriveProvider.put` stays a dispatcher. It resolves the parent, checks existing names, builds `appProperties`, and picks a path. The file should end at or below ~300 lines.
- **No change to `packages/core`.**

## Files to Create
| File | Purpose |
|------|---------|
| `packages/drive/src/api/simple-upload.ts` | `simpleUpload` (multipart POST or PATCH), moved out of the provider |
| `packages/drive/src/api/resumable.ts` | Session open, chunk loop, status query, `chunks()` reader, offset parsing, `resumableUpload`, `resumeSession` |
| `packages/drive/test/drive/resumable.test.ts` | Chunking, short confirmations, lost final response, retry, resume, expiry, callbacks |
| `packages/drive/test/drive/resumable-leak.test.ts` | Session URI never in errors, hook events or console |

## Files to Modify
| File | Changes |
|------|---------|
| `packages/drive/src/api/client.ts` | Add `rawOnce` (and let `DriveRequestInit.method` include `'PUT'`) |
| `packages/drive/src/drive-provider.ts` | `chunkSize` option and validation; `put` dispatches to `simpleUpload` or `resumableUpload`; new public `resumeUpload`; remove the inline multipart blocks |
| `packages/drive/src/index.ts` | Export the `ResumeUploadOptions` type |
| `packages/drive/test/drive/fake-drive.ts` | Resumable routes: open (returns `Location`), chunk `PUT` with `Content-Range`, status query; controls `confirmShort(bytes)`, `expireSessions()` and `failAfterApply` reuse; records chunk ranges |
| `packages/drive/test/drive/write-operations.test.ts` | The "over 5 MiB is refused" expectations move: over 5 MiB without `sha256` is refused, and unknown size is refused |
| `packages/drive/test/drive/upload.test.ts` | Keep the `readBody` limits (it is still the simple path's reader) |
| `issues/FN-06-drive-resumable-upload.md` | Execution Record |
| `issues/_index.md` | FN-06 `todo` → `planned` now; `done` only by verify-it |

## Data Requirements
- None in the library. The consumer persists the `ResumableSession` it receives (FN-13).

## Testing Strategy
- **Fake resumable server** (in `fake-drive.ts`):
  - the open route stores `{ metadata, size, received: Uint8Array, completed?: fileId }` under `upload_id=S<n>` and answers `200` with `Location: https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=S<n>`;
  - the chunk route checks that `content-range` starts at `received.length`, and otherwise answers 400, which proves offsets are respected. It appends, and answers 308 with `Range: bytes=0-<len-1>`, or, once complete, creates the file and answers 200 with the resource;
  - `confirmShort(n)` makes the next chunk keep only its first `n` bytes and confirm that;
  - `expireSessions()` makes every session answer 404;
  - status `bytes */<size>` answers the same way as the chunk route;
  - failure injection matches `upload_id=` for chunk requests and `uploadType=resumable` for the open, on path and query.
- `resumable.test.ts`, with `chunkSize: 256 * 1024` in most cases to keep the tests fast:
  1. **50 MiB in 7 chunks** with the default 8 MiB chunk size: 7 chunk requests; `onUploadProgress` reaches `totalBytes`; the result has `sha256`; the stored bytes equal the input. The input is a deterministic pattern, not zeros, so a misplaced byte is caught.
  2. The body size is an exact multiple of the chunk size (4 × 256 KiB), so there is no empty final chunk.
  3. Every `content-range` start is a multiple of 256 KiB except after a short confirmation, and every chunk except the last is exactly `chunkSize`.
  4. **Drive confirms fewer bytes:** with `confirmShort`, the next request starts at the confirmed offset, and the final content is intact.
  5. **5xx mid-chunk:** a 503 on a chunk is retried; the retry queries status first and resends from the confirmed offset.
  6. **Lost final response:** `failAfterApply` on the last chunk; the status query sees completion; exactly one file exists.
  7. **Resume in a "new process":** start an upload with an `onResumableSession` that records sessions, and abort after 2 chunks (an injected non-retryable error, or a callback that throws). Then build a **new** `DriveProvider` and call `resumeUpload({ session: lastRecorded, name, sha256, openAt })`.
     - The first resume request is a status query.
     - `openAt` is called with Drive's confirmed offset.
     - The upload completes, and the bytes equal the input.
  8. Resume when Drive is ahead of the persisted offset (the callback recorded 256 KiB, Drive has 512 KiB): `openAt(512 KiB)` is called.
  9. **Expired session:** `expireSessions()`, then `resumeUpload` rejects with `code === 'UPLOAD_SESSION_EXPIRED'` and `retryable === false`; and a mid-upload expiry rejects the same way.
  10. `onResumableSession` is awaited. A callback that resolves after a delay delays the next chunk, which a recorded order of events proves.
  11. Over 5 MiB without `sha256`, and an unknown-size stream, are refused before any request.
  12. A completed resource whose `byosSha256` differs from the caller's gives a `ProviderError`.
  13. An invalid `chunkSize` (100 KiB, or 0) throws in the constructor.
  14. `overwrite: true` over 5 MiB opens the session with `PATCH` on the existing id and keeps it.
- `resumable-leak.test.ts`:
  - session URIs from the fake contain a marker, `upload_id=SECRET-<n>`;
  - run an upload with hooks and console spies, a 503 retry, an expiry and a network error during a chunk;
  - control: at least 3 hook payloads and at least 2 errors;
  - assert that `SECRET-` and `upload_id` appear in no error (`message`, `String`, `JSON.stringify`, `stack`, `cause` undefined), no hook payload, and no console call.
- **Mutation proofs**, recorded in the Execution Record:
  - send the next chunk from "bytes sent" instead of the confirmed offset: test 4 must fail;
  - skip the status query on retry: tests 5 and 6 must fail.

## Implementation Order
1. **Riskiest first, the offset loop against the fake.**
   - Write the fake's resumable routes and `client.rawOnce`.
   - Write `api/resumable.ts` with `chunks()`, open, chunk send, offset parsing and the confirmed-offset loop.
   - Run tests 2, 3 and 4 before anything else: an off-by-one in `Range` parsing (`bytes=0-<n>` is inclusive) corrupts files silently.
2. Write the retry with the status query, plus tests 5 and 6 and their mutations.
3. Write `resumeUpload`, `openAt` and expiry, plus tests 7–9.
4. Extract `simpleUpload`, make `put` dispatch, and add `chunkSize` validation, plus tests 1 and 10–14. Update the existing write tests.
5. Write the leak test.
6. `pnpm format`, then `pnpm check`.

## Security Considerations
- The session URI is bearer-like. It is passed only to `onResumableSession` and to `fetch`, and is never part of an error message, a `cause`, a hook payload or console output, as `resumable-leak.test.ts` proves.
- The access token rides only in the `authorization` header, as before.
- The caller's `sha256` is trusted for resumable uploads (not recomputed), but the stored `byosSha256` is checked against it on completion.

## Pattern to Copy
- `packages/drive/src/drive-provider.ts` `#createWithReconcile` for "retry with a look before resending".
- `packages/drive/test/drive/write-operations.test.ts` for the test layout with `setup()` and request counting.
- `packages/drive/test/drive/hooks.test.ts` for the leak test.

## Verification
- Command: `pnpm check` (green, with the two new drive test files).
- Command: `grep -rn "node:\|console\." packages/drive/src` (no output).
- Command: `wc -l packages/drive/src/drive-provider.ts` (at or below ~300 lines after the split).
- Every number in the acceptance criteria and scenarios is measured by a test in `resumable.test.ts`:
  - "7 chunks" counts the fake's chunk requests;
  - "256 KiB-aligned" checks every `content-range` start;
  - "100 %" is the last `onUploadProgress` equal to `totalBytes`.
- **Done when:** `pnpm check` is green and both mutation proofs fail as expected and are restored. The delivery carries the check counts per step, the mutation results, and the verify-it report.

## Out of Scope
- Unknown-length resumable uploads (`*` total).
- Persisting sessions, and Ctrl+C handling (FN-13).
- Parallel chunk upload (Drive requires sequential chunks per session).
- Computing SHA-256 while streaming.
- `move`, `copy` and `delete` (FN-07).
- Any change to `packages/core`.

## Checkpoint
- `Checkpoint: nao`

---

# Execution Record

- Branch `feat/FN-06-drive-resumable`, executed 2026-11-21. Owner approved two deviations from the issue text before execution:
  - uploads over 5 MiB need `size` and `sha256` (no unknown-length uploads);
  - `resumeUpload` takes `openAt(offset)` instead of a body already positioned.
- Step 1 (riskiest): `DriveClient.rawOnce` (one attempt, 401 refresh, no status mapping) and `api/resumable.ts`, with chunk reading, session open, chunk send, `Range` parsing (`bytes=0-<n>` is inclusive, so `n + 1`) and the confirmed-offset loop. The fake resumable server answers 400 to any chunk that doesn't start at the bytes it holds, so a wrong offset can't pass silently.
- Mutation proofs (each restored and checked with `cmp`):
  - offset taken from bytes sent instead of Drive's `Range`: the short-confirmation test fails;
  - no status query before a retry: the 503-retry test and the lost-final-response test fail;
  - the session URI in the status-query error, then in the progress event: the leak test fails both times. A first attempt, putting the URI in a chunk error, was swallowed by the retry and never reached the caller, so it proved nothing about the test; it is recorded here, not counted;
  - no session URI validation on resume: the 8 refusal cases fail.
- **Security review during execution:** an automated review flagged that `resumeUpload` sent the bearer token to whatever URI the consumer passed, and that URI comes from the consumer's storage (FN-13's manifest). `assertSessionUri` now requires `https://www.googleapis.com/upload/drive/v3/files…?upload_id=…` (no other host, port or userinfo) on the open's `Location` and on resume, before any request. Tested with 8 bad URIs and a bad `Location`.
  - `redirect: 'manual'` was not added, because it turns a 308 into an opaque redirect in browsers and React Native.
  - Omitting the token on session requests was not adopted either: it is `[assumed]` unnecessary, and only FN-15 can verify it; with the host pinned, the token can't leave Google.
- Other deviations from the plan:
  - The folder and create-reconciliation logic moved to `api/creates.ts` (`createWithReconcile`, `FolderMaker`), next to `api/simple-upload.ts` and `api/resumable.ts`, to bring `drive-provider.ts` from ~350 down to 296 lines.
  - `test/drive/setup.ts` takes `chunkSize`, and the fake gained `failAfterApplyWhen(predicate, reply)`, to hit only the final chunk.
  - Progress reports 100 % also when the last chunk completes the upload.
  - The 50 MiB test has its own 30 s timeout: it took 0.3 s and then 6.9 s under machine load, against the default 5 s.
- First final `pnpm check` failed on lint with one `no-unnecessary-template-expression` in the leak test. Fixed.
- `pnpm check`: build, lint (ESLint 0 warnings, Prettier clean), typecheck and tests green: 224 passed (69 in core, 128 in drive, 2 in cli, 25 in the root suite). `grep -rn "node:\|console\." packages/drive/src` prints nothing; `wc -l packages/drive/src/drive-provider.ts` gives 296.
- After the independent verification (93, no vetoes):
  - The stream path of `chunks()` keeps reads in a list and joins them once per chunk; before, it copied the growing buffer on every read. It is now tested with a stream read in irregular pieces of about 100 KiB against 256 KiB chunks.
  - A status that confirms more than the chunk being sent (a second writer on the session) is now a fatal error instead of a silent desync of the reader.
  - Tests were added for content shorter than `size` and for Drive that stops confirming bytes.
  - The stale "not implemented" text in `api/upload.ts` was corrected.
  - Memory: `pending` can hold up to about two chunks (a partly confirmed chunk plus the next read). That is bounded, and recorded instead of the plan's "one chunk".
- Final `pnpm check` after the fixes: green, 227 tests (69 in core, 131 in drive, 2 in cli, 25 in the root suite).
