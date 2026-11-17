# [FN-05] Drive provider: mkdir and simple upload

## Type
Functional

## Description
Write path for small files and folders: idempotent `mkdir` and `put` with a multipart upload up to 5 MiB, writing BYOS's SHA-256 into the file's `appProperties`.

## User Flow
1. Consumer calls `mkdir({ path: "Bills to Pay/2026-11", parents: true })` and gets the folder `FileStat`.
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
