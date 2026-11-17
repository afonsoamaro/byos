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
