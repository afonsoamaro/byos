# BYOS Specs

Bring Your Own Storage: an open-source TypeScript library that lets an application keep its user's files in the user's own cloud storage, Google Drive first, plus a CLI whose first job is backing up a photo folder.

Written 2026-11-13, after `DISCOVERY.md` (2026-09-07, verdict go-with-conditions, radically reduced). The earlier design handoff (`byos_storage_google_drive_first_monorepo_skeleton.md`, `README_HANDOFF.md`) is superseded by this document; it described sync, tombstones and change feeds that are explicitly out of scope here.

## Overview

BYOS is three packages in one pnpm monorepo:

- `@byos/core`: the provider-agnostic contract (`StorageProvider`, file references, errors, `TokenStore`), runtime-agnostic.
- `@byos/drive`: the Google Drive provider, built on `fetch` and the Drive REST API v3, runtime-agnostic.
- `@byos/cli`: a Node CLI with OAuth, a `doctor` command, the file operations, and `byos backup <folder>`.

The first real consumer is `byos backup` running on the owner's Windows machine, backing up a photo folder to the owner's Drive. The second is the owner's bill tracker, a Python app that calls the CLI as a subprocess. The next consumer after v1 is a mobile photo-backup app (Expo), specified separately.

## Problem Statement

Applications that store user files usually store them in the developer's bucket: the developer pays for it, holds the data, and the user can't see or take their files without the app. The alternative, writing into the user's own Drive, means every app re-implements the same OAuth dance, token refresh, folder handling, resumable upload and rate-limit backoff, against one provider SDK at a time.

The owner's concrete case: photos and videos on a Windows PC (and later on phones and a Mac) need a backup that lives in the owner's own Google Drive, visible and openable there, without a third-party backup service in the middle.

The discovery's central finding still holds: the hard problem in this category is **onboarding**, not file operations. rclone's shared Google client_id is being retired during 2026 and its users now create their own Google Cloud project. Any design that pushes that cost onto end users has few adopters.

## Goals

- `byos backup C:\Users\<me>\Pictures` backs up every file in the folder to Drive, re-runs upload only new or changed files, and resumes an interrupted large video upload without starting over.
- A developer goes from nothing to a working token in under 15 minutes by following `byos doctor`, with no security assessment, because BYOS only ever requests non-sensitive scopes.
- An application end user never sees a cloud console: they click "Connect Google Drive", consent, and are done.
- The bill tracker archives its decrypted PDFs to the owner's Drive through `byos put`, with no Python library involved.
- `@byos/core` and `@byos/drive` import nothing Node-specific, so the Expo app can consume them later without a fork.

## Scope

### In v1

- `@byos/core`, `@byos/drive`, `@byos/cli`.
- OAuth 2.0 authorization code flow with PKCE; loopback redirect in the CLI.
- The full file operation set: `list`, `stat`, `get`, `put`, `mkdir`, `move`, `copy`, `delete`. Owner decision: the full set ships even though v1 consumers only exercise part of it (backup uses `stat`, `mkdir`, `put`, `list`, `get` for verify; the bill tracker uses `put`). `move`, `copy` and `delete` ship without a first consumer, which is a known risk to their interface.
- Path resolution as a convenience on top of ID references.
- SHA-256 content hash stored on each uploaded file.
- `byos backup`: one-way, additive, resumable.
- `byos doctor`.

### Explicitly out of scope

- **Sync of any kind.** No bidirectional sync, no tombstones, no Drive Changes API, no watch mode, no conflict resolution. This is removed, not deferred: the architecture must not carry state, cursors or abstractions that only exist for a future sync. The discovery's reasoning: bidirectional sync is rclone's ground and where file-sync libraries go to die.
- Deletion propagation: a file removed locally is never removed from Drive by `backup`.
- Client-side encryption (see Future).
- Any provider other than Google Drive. A second provider is added only after a real consumer runs on the first one.
- The NestJS module from the old design. A framework module comes only when a Node backend consumes BYOS.
- A Python implementation.
- The mobile and desktop photo apps themselves (each gets its own spec).
- The full `drive` scope, ever (see Onboarding).

## Onboarding and OAuth

This is the gating design artifact the discovery asked for, and it is designed before the API.

### Scopes

- BYOS requests `https://www.googleapis.com/auth/drive.file` by default, plus `drive.appdata` only when the consumer asks for app-private state.
- Both are classified by Google as **non-sensitive, recommended** scopes: they need basic OAuth app verification only, not the security assessment (CASA) that restricted scopes like `drive` require. Source: Google's Drive API scope guide.
- BYOS refuses to request `drive` or `drive.readonly`. This is a product principle, documented in the README: it is what keeps developer onboarding cheap.
- Consequence of `drive.file`, documented up front: the app sees only files it created (or files the user picked through Google Picker). A photo dragged into the backup folder through the Drive website is invisible to BYOS. Moving or renaming a file the app created keeps access, because access is per file.

### Two personas

**Developer (once per application).** Creates a Google Cloud project, enables the Drive API, configures an External consent screen with `drive.file`, creates OAuth clients (Desktop for the CLI; iOS/Android later for Expo), and publishes the app to "In production". `byos doctor` walks this and checks what it can.

**End user (once per device or install).** Clicks "Connect Google Drive" (or runs `byos auth`), consents in the browser, returns. Never sees a console.

For the owner's personal use, the owner is both personas: their own Google Cloud project, their own client_id. This is the rclone situation, and it is acceptable for a personal tool when `doctor` makes it a guided 15 minutes.

### Testing mode trap

A consent screen left in "Testing" caps the app at 100 test users and **expires refresh tokens 7 days after consent**. Source: Google Cloud help, OAuth consent screen publishing status. This silently kills any personal app after a week.

- `doctor` tells the developer to publish to production and explains why.
- The CLI records consent time with the token. When a refresh fails with `invalid_grant` roughly 7 days after consent, the error message names Testing mode as the likely cause instead of a generic "token expired".

### Token handling

- Tokens belong to the consuming app. `@byos/core` defines `TokenStore` (`load`, `save`, `clear` by key); the app decides where tokens live.
- `@byos/cli` ships a file-based store, encrypted at rest (AES-256-GCM via Web Crypto), in the OS config directory (`%APPDATA%\byos` on Windows, `~/Library/Application Support/byos` on macOS, `$XDG_CONFIG_HOME/byos` on Linux), with the key from the OS keychain when available or a passphrase/env var otherwise (see Open Questions).
- Access tokens are refreshed transparently by `@byos/drive` before expiry and on a 401, once; the refreshed token is written back through `TokenStore`.
- Tokens, authorization codes, and URLs carrying them are never logged, and error messages from network failures never embed request URLs (a lesson recorded for `httpx` in another project; same rule here for any HTTP client).

## User Stories

- As the owner on Windows, I run `byos auth`, a browser opens, I consent, and the CLI says I'm connected as `<my Google account>`.
- As the owner, I run `byos backup C:\Users\me\Pictures` and every photo and video appears in Drive under `BYOS Backup/<device>/Pictures/...`, with the same subfolders.
- As the owner, I run the same command next week and only the new photos upload; the run ends in seconds when nothing changed.
- As the owner, my connection drops in the middle of a 3 GB video; the next run continues that upload from where it stopped.
- As the owner, I delete a photo from my PC; the Drive copy stays.
- As the owner, I run `byos doctor` and it tells me exactly which setup step is missing (API not enabled, wrong redirect, consent screen in Testing).
- As the bill tracker, I call `byos put ./out/2026-11/statement.pdf --remote "Archive/2026-11" --json` and get back the Drive file ID and hash; on failure I get a non-zero exit code and a JSON error, and I retry later without blocking ingestion.
- As a future app developer, I import `@byos/drive`, pass my client config and a `TokenStore`, and call `put` from React Native without polyfilling Node APIs.

## Functional Requirements

### `@byos/core`

- `StorageProvider` interface: `list`, `stat`, `get`, `put`, `mkdir`, `move`, `copy`, `delete`.
- References are **IDs first**. Every result carries the provider file ID; consumers persist IDs, not paths. Path-based calls (`{ path: "a/b/c.jpg" }`) are resolved to IDs by a `PathResolver` with an in-memory cache that invalidates on `NotFound`.
- Bodies are Web `ReadableStream<Uint8Array>` / `Uint8Array` / `Blob`, not Node streams, so core stays runtime-agnostic.
- Typed errors: `NotFoundError`, `ConflictError`, `PermissionError`, `AuthError` (with a `reason`, including `testing-mode-expiry-suspected`), `RateLimitError`, `QuotaExceededError`, `ProviderError` (wraps the rest, with `retryable` telling a transient failure from a rejected request). Every error carries a stable `code` string for CLI JSON output.
- `FileStat`: `id`, `name`, `parents`, `isFolder`, `size`, `mimeType`, `modifiedAt`, `createdAt`, `md5` (provider-native when available), `sha256` (BYOS-written), `appProperties`.
- Retry helper: exponential backoff with full jitter, bounded attempts, honoring `Retry-After`; used by providers, not by consumers.
- No sync primitives: no cursor, no change feed, no tombstone types.

### `@byos/drive`

- Implements `StorageProvider` over Drive REST v3 with `fetch` (injectable, for tests and for runtimes with a custom fetch).
- OAuth helpers: build the authorization URL with PKCE (S256), exchange the code, refresh. The redirect transport (loopback server, deep link) belongs to the consumer.
- `put`: simple multipart upload up to 5 MiB, **resumable upload** above it, in chunks that are a multiple of 256 KiB (default 8 MiB). The resumable session URI and confirmed offset are exposed through a callback so the consumer can persist them and resume after a process restart.
- On upload, writes `appProperties.byosSha256` (hex SHA-256 of the content) and `appProperties.byosVersion`.
- `put` with `overwrite: false` (default) and an existing same-name file in the target folder raises `ConflictError`; `overwrite: true` creates a new revision of the existing file ID.
- `mkdir` with `parents: true`, idempotent: returns the existing folder when one with that name exists under the parent. Concurrent `mkdir` of the same path within one process is serialized.
- Maps Drive 403 `userRateLimitExceeded`/`rateLimitExceeded` and 429 to `RateLimitError` and retries; maps 403 `storageQuotaExceeded` to `QuotaExceededError` (not retried); maps `invalid_grant` to `AuthError`.
- Requests only `fields` it needs (partial responses) to keep list calls cheap.

### `@byos/cli`

Commands:

- `byos auth [--client <path to client JSON>]`: loopback OAuth on `127.0.0.1` with a random free port, opens the default browser, stores the token. `byos auth status` shows account email, scopes, consent date. `byos auth logout` revokes and clears.
- `byos doctor`: checks client JSON shape and type (Desktop), Drive API reachability, granted scopes (warns on anything beyond `drive.file`/`drive.appdata`), token validity and age, and prints the Testing-mode warning with the fix. Each failing check prints the exact console step to fix it.
- `byos ls|stat|get|put|mkdir|mv|cp|rm <remote path or id>`: thin wrappers over the provider. `--json` on every command for machine use; exit code 0 on success, non-zero with a JSON error `{ code, message }` on failure.
- `byos backup <local folder> [--device <name>] [--remote-root "BYOS Backup"] [--concurrency 4] [--dry-run] [--exclude <glob>]`:
  - Remote layout mirrors the local folder: `<remote-root>/<device>/<folder name>/<relative path>`. `--device` defaults to the machine hostname.
  - Includes every regular file (photos, videos, anything), skipping hidden/system files (`Thumbs.db`, `desktop.ini`, `.DS_Store`) and `--exclude` globs.
  - **Additive only**: never deletes or overwrites remote files. A local file whose content changed is uploaded as a new revision of the same Drive file ID (Drive keeps prior revisions per its own retention).
  - Change detection: a local manifest maps relative path → size, mtime, SHA-256, Drive file ID. Size and mtime unchanged means skip without hashing; otherwise hash and compare with the stored SHA-256.
  - Resumable: in-flight resumable session URIs and offsets are kept in the manifest; the next run resumes them (falling back to a fresh upload when Drive reports the session expired).
  - Progress output: files scanned, to upload, uploaded, skipped, failed, bytes; a final summary; non-zero exit when any file failed.
  - `--verify` re-reads Drive `stat` for every manifest entry and reports missing or hash-mismatched remote files (no auto-repair in v1).
- The manifest lives in the OS data directory, one per (local folder, device, remote root), in `node:sqlite`.

### Bill tracker integration (consumer, not BYOS code)

- The bill tracker calls `byos put` after a PDF is decrypted and organized, in a background task. A failure marks the file "archive pending" and is retried; it never blocks ingestion.
- Only the decrypted PDF goes to Drive, under `Archive/<YYYY-MM>/`.
- A one-off backfill script sends existing PDFs, idempotent by the hash the bill tracker already computes.
- The VPS stays the primary store; Drive is the archive copy (owner decision).

## Non-Functional Requirements

- **Security**: least-privilege scopes only; PKCE on every flow; tokens encrypted at rest in the CLI store; no secret in logs, errors, or `--json` output; client secret treated as non-confidential for Desktop clients (Google's model) but still never printed.
- **Reliability**: an interrupted `backup` (Ctrl+C, crash, network loss) leaves the manifest consistent; re-running converges. Upload of a file is recorded in the manifest only after Drive confirms it.
- **Performance**: a no-change re-run over 20,000 files finishes in under 30 seconds on a local SSD (stat-only path). Default concurrency 4 uploads; backoff keeps the run under Drive's per-user rate limits without manual tuning.
- **Portability**: `@byos/core` and `@byos/drive` have zero Node built-in imports, enforced by a lint rule and a test that bundles them for a browser target. The CLI runs on Windows, macOS and Linux; path handling uses relative POSIX paths internally and is tested with Windows separators, case-insensitive collisions and long paths.
- **Observability**: the library emits no telemetry by default. Providers accept an optional event hook (`onRequest`, `onRetry`, `onUploadProgress`) so a consumer can wire OpenTelemetry itself. `[assumed]` A library forcing an OTel dependency on every consumer is worse than a hook; the portfolio's OTel rule targets backends, and BYOS has none.
- **i18n**: CLI output is English only in v1. `[assumed]` The portfolio's three-language rule targets app UI; the Expo app will localize its own UI and map BYOS error `code`s to messages.

## Tech Stack

Versions checked 2026-11-13 with `npm view`, not recalled.

| Piece | Version | Note |
|---|---|---|
| Node | 26.13.1 (LTS) | `devEngines.runtime` `^26`, `.nvmrc` for local `nvm use` |
| pnpm | 12.18.0 | `packageManager` field |
| TypeScript | **6.0.3** `[assumed]` | 7.0.2 is current, but `typescript-eslint` 8.72.2 declares `typescript: >=4.8.4 <6.1.0`; with TS 7 the typecheck passes and lint silently breaks. Revisit when typescript-eslint widens the peer |
| typescript-eslint | 8.72.2 | `strictTypeChecked`, `defineConfig` from `eslint/config` |
| ESLint | 10.14.0 | No React preset involved, so no 9.x pin needed |
| Vitest | 5.1.0 | Unit tests with injected `fetch`, no network in the gate |
| Zod | 4.6.7 | Validates client JSON, CLI config and Drive responses at the boundary |
| commander | 15.1.0 | CLI parsing |
| `tsc` | (TypeScript above) | Builds ESM + types per package, file by file; no bundler needed for a library (decided in FN-00 planning, 2026-11-15) |
| p-limit | 7.3.3 | Upload concurrency in the CLI |
| `node:sqlite` | built into Node 26 | Backup manifest, no native dependency |

Deliberately not used:

- `googleapis` (190.0.0) and `google-auth-library` (11.3.4): Node-only, and `googleapis` is very large. They would break the runtime-agnostic goal for `core`/`drive`. Drive REST v3 plus the OAuth token endpoint are small enough to call with `fetch`.
- Any HTTP client library: `fetch` is native in Node 26 and in React Native.

## Architecture Overview

```
@byos/cli (Node)                 future Expo app            bill tracker (Python)
  auth (loopback + PKCE)           auth (deep link + PKCE)     subprocess: byos put --json
  doctor                           TokenStore (SecureStore)          |
  backup (scan, manifest,                 |                          |
          sqlite, p-limit)                |                          |
  TokenStore (encrypted file)             |                          |
        \                                 |                    (via @byos/cli)
         \________________________________|
                          |
                    @byos/drive  (fetch, Drive REST v3, OAuth endpoints,
                          |       resumable upload, error mapping)
                    @byos/core   (StorageProvider, FileStat, errors,
                                  TokenStore, PathResolver, retry)
```

Backup flow: scan folder → for each file, compare size+mtime with the manifest → hash if needed → `mkdir -p` the remote folder (cached ID) → `put` (simple or resumable, session persisted) → write `byosSha256` → record ID and hash in the manifest.

Repository: `afonsoamaro/byos`, public, MIT licensed, pnpm workspace with `packages/core`, `packages/drive`, `packages/cli`. CI runs `pnpm check` (lint, typecheck, test, build per package) on `pull_request` and on `push` to `main`, with `pnpm/setup` pinned by SHA and `dependabot.yml` for npm and `github-actions`. No ports, database or Redis: BYOS is a library and CLI, not a service.

## Constraints

- Google Drive API per-user rate limits and the user's Drive quota; quota exhaustion is a hard stop with a clear message, not a retry.
- `drive.file` visibility limits (see Onboarding); accepted as the price of non-sensitive scopes.
- The OAuth client for each platform (Desktop, iOS, Android) is created by the developer in their own Google Cloud project; BYOS cannot ship a shared client_id, and doing so would recreate the rclone problem.
- Repo is public from day one: no personal paths, private infra or other project names in committed text.
- The old design document stays in the repo history only as reference; nothing from its sync engine is ported.

## Future (does not shape v1 architecture)

- Mobile photo-backup app (Expo) consuming `@byos/core` + `@byos/drive`, with its own spec. Next consumer.
- Desktop clients (Mac, Windows tray app) wrapping the same backup logic.
- Cross-device browsing: each device lists and downloads what the others backed up (read-only), which v1's `list`/`get` already allow.
- Optional client-side encryption.
- A second provider (OneDrive, Dropbox or WebDAV), after a real consumer runs on Drive.
- Bidirectional sync: only if a concrete need forces it, and only with its own discovery.

## Open Questions

1. **Cross-device visibility under `drive.file`.** The hypothesis is that `drive.file` grants access per Cloud project, so files uploaded by the CLI (Desktop client) are visible to the Expo app (iOS/Android clients) of the same project. Must be validated with two clients in one project in the first prototype; if false, cross-device browsing needs the Picker or a different design.
2. **Headless auth for the bill tracker on the VPS.** The VPS has no browser. Options: run `byos auth` on a laptop and copy the encrypted token file plus key; or Google's limited-input device flow, if it accepts `drive.file` (to verify). Decide before the bill tracker integration.
3. **Token encryption key source in the CLI.** OS keychain (Windows Credential Manager, macOS Keychain) needs a native module or a shell-out; a passphrase or `BYOS_TOKEN_KEY` env var is simpler and works on the VPS. Pick per platform in the FN that builds the token store.
4. **Does a non-sensitive-scope app published to production without brand verification still show the "unverified app" warning, and does the 100-user cap apply?** Affects the README's onboarding promise for other developers; the owner's own use is unaffected.
5. **npm scope.** Unscoped `byos` is taken by an unrelated package (2022). No package exists under `@byos`, but owning the npm org must be confirmed before the first publish; fallback is a scope under the owner's account.
6. **Prototype speed gate.** The owner's rule: if a simple Windows photo-backup prototype comes quickly, it is the first consumer; if not, the bill tracker's `byos put` goes first. Both paths need `auth` + `put`, so the first issues are the same either way.
