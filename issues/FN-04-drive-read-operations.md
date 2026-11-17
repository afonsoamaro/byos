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
