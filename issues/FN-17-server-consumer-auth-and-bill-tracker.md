# [FN-17] Headless auth for server consumers (bill tracker integration)

## Type
Functional

Checkpoint: sim (security: moving a token to a server)

## Description
SPECS open question 2. The bill tracker runs on a VPS with no browser and calls `byos put --json` as a subprocess to archive decrypted PDFs in the owner's Drive. The VPS needs a token without running a browser flow there. This issue picks and implements the mechanism on the BYOS side and documents the subprocess contract; the bill tracker's own change is an issue in its own repository.

## User Flow
1. Owner runs `byos auth` on a laptop.
2. Owner runs `byos auth export --out token.byos` (encrypted with a passphrase or the target's `BYOS_TOKEN_KEY`).
3. On the VPS: `byos auth import token.byos` with `BYOS_TOKEN_KEY` from the server's secrets.
4. The bill tracker calls `byos put <pdf> --remote "Archive/<YYYY-MM>" --mkdir --if-absent --json`.

## Requirements
- First, check whether Google's limited-input device flow accepts `drive.file`; record the answer here with the source. If it does, offer `byos auth --device` as an alternative; export/import is still implemented, as it works offline.
- Export file encrypted (AES-256-GCM, key derived from a passphrase with a strong KDF, or the target key); never plaintext; import validates and stores through FN-08.
- `docs/server-usage.md`: install on a server, token import, env vars, the `--json` contract and exit codes (from FN-11), and retry guidance (`--if-absent` makes retries safe).
- **Security**: the export file is a credential; docs say so, recommend deleting it after import, and the CLI refuses to write it with permissions wider than owner-only.
- Bill tracker side (not this repo): the call runs in a background task after decrypt; failure marks the file "archive pending" and never blocks ingestion; only the decrypted PDF goes to Drive under `Archive/<YYYY-MM>/`; a one-off backfill sends existing PDFs. Create that issue in the bill tracker's repo after owner confirmation and link it here.

## Scenarios
### Happy Path
- Export on one machine, import on another (test with two config dirs), `put --json` succeeds with the imported token.
### Edge Cases
- Imported token later hits `invalid_grant`: the JSON error carries `AUTH_FAILED` and the reason, so the bill tracker can alert the owner.
### Error Handling
- Wrong passphrase/key on import: clear error, nothing stored.

## Data Requirements
- Export envelope format (versioned).

## External Dependencies
- Google device flow documentation (to verify scope support).

## Acceptance Criteria
- [ ] Device-flow scope support checked and recorded with source.
- [ ] `auth export`/`auth import` round-trip between two config dirs.
- [ ] Export file never contains plaintext token (asserted) and is written owner-only.
- [ ] `docs/server-usage.md` written.
- [ ] Bill tracker issue created in its repo (after owner confirmation) and linked.

## Dependencies
- FN-11.

---

# Implementation Plan

## Decisions (owner, 2026-11-21)
- **Both mechanisms ship:** `byos auth --device` (Google's device authorization flow, run directly on the server) **and** `byos auth export` / `import` (an encrypted bundle, which works offline).
- **The device flow accepts `drive.file`.** Checked on 2026-11-21 against Google's page "OAuth 2.0 for TV and Limited-Input Device Applications" (developers.google.com/identity/protocols/oauth2/limited-input-device). Its "Allowed scopes" lists exactly `https://www.googleapis.com/auth/drive.appdata` and `https://www.googleapis.com/auth/drive.file` for the Drive API.
  - It needs an OAuth client of type **"TVs and Limited Input devices"**.
  - The device authorization endpoint is `https://oauth2.googleapis.com/device/code`. Polling uses `https://oauth2.googleapis.com/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code`.

## Prerequisites
- FN-11 done: CLI skeleton, `auth` commands, `client-file.ts`, `FileTokenStore`, `writeFileAtomic`, `put --if-absent --json` and the exit codes.
- FN-03: `packages/drive/src/oauth/*` (scope allowlist, `mapTokenError`, the no-secret rules).
- Branch `feat/FN-17-headless-auth` from an up-to-date `main`. Node 26 in every shell, background ones included.

## Priorities
1. **The export bundle is a credential:** never plaintext, owner-only on disk, and never printed. Device codes and tokens are never printed either; only the short `user_code` is shown, since it is meant for the human.
2. The subprocess contract documented for server consumers.
3. The acceptance criteria.

## Reusable Code Found
- `packages/drive/src/oauth/constants.ts`: `DRIVE_SCOPES` (the allowlist), `TOKEN_URL`.
- `packages/drive/src/oauth/errors.ts` and `packages/drive/src/http-errors.ts`: `mapTokenError`, `networkError`, and the message rules (short code only, no `error_description`).
- `packages/drive/src/oauth/token-client.ts`: the zod token response schema and `scopesOf`. `requestToken` is reused by extracting it, or mirrored.
- `packages/cli/src/client-file.ts`: the Desktop client loader, extended for the device client.
- `packages/cli/src/store/*`: `FileTokenStore`, `writeFileAtomic`, `configDir`.
- `packages/cli/src/commands/auth.ts` (FN-09): the command group to extend.

## Knowledge Registry
- **No secrets anywhere:** tokens, codes and verifiers never appear in output, errors (no `cause`) or events. Absence tests need a control.
- **Fake `fetch`:** no `as` assertion.
- **Background shells start on Node 24.**

## Architecture Decisions
- **Device flow in the library (`packages/drive/src/oauth/device-flow.ts`):**
  - `requestDeviceCode({ clientId, scopes?, fetch? })` POSTs `client_id` and `scope` (allowlisted exactly like `createAuthRequest`; anything else throws before sending). It returns `{ deviceCode, userCode, verificationUrl, expiresInMs, intervalMs }`, validated with zod.
  - `pollDeviceToken({ clientId, clientSecret?, deviceCode, intervalMs, expiresInMs, fetch?, now?, sleep? })` POSTs `grant_type=urn:ietf:params:oauth:grant-type:device_code` until a result:
    - `authorization_pending`: wait `intervalMs`;
    - `slow_down`: add 5 s to the interval (RFC 8628);
    - `access_denied`: `AuthError('the sign-in was declined on the other device', { reason: 'invalid-grant' })`;
    - `expired_token`, or past `expiresInMs`: `AuthError('the device code expired; run the sign-in again', { reason: 'invalid-grant' })`;
    - success gives a `StoredToken`, with `consentedAt = now` and the granted scopes from the response;
    - other errors go through `mapTokenError`.
  - `sleep` is injectable for tests.
  - Exported from `@byos/drive`.
- **Device client file:**
  - `client-file.ts` gains `loadDeviceClient(path)`, which accepts the downloaded JSON for a "TVs and Limited Input devices" client;
  - `[assumed]`: its JSON uses the `installed` key like Desktop clients. If the owner's download differs, the loader accepts the observed key, and the shape is recorded in the Execution Record;
  - `byos auth --device --client <tv.json>` refuses a Desktop or Web client with a message naming the needed type.
- **`byos auth --device --client <file>`:**
  - it prints `Go to <verificationUrl> and enter <userCode>`, with the PP-02 step style, and `… Waiting for Google (expires in N minutes)`;
  - it polls, saves through `FileTokenStore` (with `mergeReconnect`), runs `provider.account()`, and prints `✓ Connected as <email>`;
  - `--json` prints `{ verificationUrl, userCode }` first, as one line on stderr so stdout stays one document, and the final `{ account, scopes }` on stdout.
- **Export and import:**
  - `byos auth export --out <file> [--force]`: the bundle plaintext is `{ v: 1, client: <the client JSON object>, token: StoredToken, account }`.
    - The client is included because the server needs `client_id` and the (non-confidential) Desktop secret to refresh.
    - **Encryption:** `node:crypto` `scrypt` (N = 2^17, r = 8, p = 1, `maxmem` 256 MiB) on the passphrase with a random 16-byte salt, giving a 32-byte key, then AES-256-GCM with a random 12-byte IV. The AAD is the literal `byos-token-export-v1`.
    - **File format:** JSON `{ v: 1, kdf: 'scrypt', N, r, p, salt, iv, ct }`, base64 fields.
    - **The passphrase** comes from `BYOS_EXPORT_PASSPHRASE` (for scripts) or from a no-echo TTY prompt asked twice. It needs at least 12 characters, else exit 2. With no TTY and no env var: exit 2.
    - **Permissions:** the file is written with `writeFileAtomic` (mode 0600, `'wx'`). An existing file gives exit 4 unless `--force`. With `--force` on POSIX, it is re-created with 0600, never written into a wider-permission file. On Windows the per-user profile ACL applies, documented as in FN-08.
    - It prints a reminder: "this file is a credential: move it securely and delete it after import".
  - `byos auth import <file> [--force]`:
    - it reads the file and derives the key from the same passphrase source;
    - a decrypt failure gives `AuthError("the export can't be opened (wrong passphrase or damaged file)", { reason: 'missing-token' })`, exit 5, and stores nothing;
    - it validates the bundle (the client must be `installed`, and the token fields must be there);
    - it writes the client JSON into `<configDir>/client.json` (0600), points the config at it, saves the token through `FileTokenStore` (with that machine's `BYOS_TOKEN_KEY` or key file), and saves the account;
    - an existing sign-in gives exit 4 unless `--force`.
  - The issue's "or the target key" option (encrypting the export with the target's `BYOS_TOKEN_KEY`) is not implemented: the passphrase covers it without sharing raw keys between machines. Recorded as a deviation.
- **`docs/server-usage.md`:**
  - install on a server: Node 26, then the packages (npm after FN-19, tarballs before);
  - choosing between `--device` and export/import;
  - env vars: `BYOS_TOKEN_KEY` (recommended on servers, so the token key isn't a file next to the tokens), `BYOS_CONFIG_DIR`, `BYOS_DATA_DIR`, `BYOS_EXPORT_PASSPHRASE`;
  - the `--json` contract and exit codes, linking `docs/cli-output.md`;
  - `put --if-absent` makes retries safe;
  - how to read `AUTH_FAILED` with `reason` (alert the owner);
  - the Testing-mode 7-day trap.
- **Bill tracker side:** an issue is created in the consumer's repository **only after the owner confirms**, at execution time. Because that repository is private and this one is public, **this issue does not name or link it**: the Execution Record says "consumer issue created (private repository)" with the date.

## Files to Create
| File | Purpose |
|------|---------|
| `packages/drive/src/oauth/device-flow.ts` | `requestDeviceCode`, `pollDeviceToken` |
| `packages/drive/test/oauth/device-flow.test.ts` | Allowlist, pending, slow_down, denied, expired, success, no secrets in errors |
| `packages/cli/src/auth/export-bundle.ts` | scrypt + AES-GCM seal and open, bundle validation |
| `packages/cli/src/auth/passphrase.ts` | Env or no-echo TTY prompt (twice for export) |
| `packages/cli/test/device-auth.test.ts` | `auth --device` through `main()` with a fake Google |
| `packages/cli/test/export-import.test.ts` | Round-trip between two config dirs, wrong passphrase, permissions, no plaintext, `put --if-absent --json` with the imported token |
| `docs/server-usage.md` | Server guide and subprocess contract |

## Files to Modify
| File | Changes |
|------|---------|
| `packages/drive/src/index.ts` | Export the device-flow functions and types |
| `packages/cli/src/client-file.ts` | `loadDeviceClient` |
| `packages/cli/src/commands/auth.ts` | `--device`, `export`, `import` |
| `packages/cli/test/helpers.ts` | Fake routes for `/device/code` |
| `SPECS.md` | Open Question 2: resolved (both mechanisms, with the device-flow source and date) |
| `issues/FN-17-server-consumer-auth-and-bill-tracker.md` | Execution Record |
| `issues/_index.md` | FN-17 `todo` → `planned` now; `done` only by verify-it |

## Data Requirements
- The export file format above. On import, `<configDir>/client.json` (0600).

## Testing Strategy
- `device-flow.test.ts`, with a fake `fetch` and an injected `sleep` that records waits:
  - `drive` and `drive.readonly` scopes throw before any request;
  - pending, pending, then success: 3 polls, the waits equal `intervalMs`, and the token is returned with `consentedAt`;
  - `slow_down` raises the wait by 5 s;
  - `access_denied` and `expired_token` give `AuthError`;
  - passing the deadline gives `AuthError`;
  - leak: errors stringified (`message`, `JSON`, `stack`) contain neither the `device_code` nor the tokens. Control: the token call succeeded in another case.
- `device-auth.test.ts`:
  - human output shows the URL and the user code, never the device code;
  - the token is saved and the account is printed;
  - a Desktop client JSON is accepted only if it is the device type, else exit 2 or 5 per the error.
- `export-import.test.ts` uses config dirs A and B, `BYOS_EXPORT_PASSPHRASE` set, and different `BYOS_TOKEN_KEY` values in A and B:
  1. sign in at A (seed the store directly), export, import at B: B's `auth status --json` shows the same account and scopes, and B's token file decrypts only with B's key;
  2. **no plaintext:** the export file contains neither the access nor the refresh token, the client secret, nor their base64. Control: import restores them;
  3. a wrong passphrase gives exit 5, and B's store and config are unchanged;
  4. POSIX: the export file mode is `0600`; an existing file gives exit 4 without `--force`;
  5. a passphrase shorter than 12 characters gives exit 2; no TTY and no env gives exit 2;
  6. **server path:** after import at B, `put <file> --remote Archive/2026-11 --mkdir --if-absent --json` against `MemoryProvider` (the `createProvider` seam) succeeds, and a second call is a no-op with the same id;
  7. a later `invalid_grant` gives JSON `{ code: 'AUTH_FAILED', reason: 'invalid-grant' | 'testing-mode-expiry-suspected', message }` and exit 5.
- Mutation proof: encrypt the export with a fixed IV, or skip the AAD; at least the tamper or plaintext tests must fail. The result is recorded.

## Implementation Order
1. **Riskiest first, the export crypto.** Write `export-bundle.ts` (scrypt, AES-GCM, format, validation), then tests 2, 3 and 4. **Checkpoint: `pnpm check`.**
2. Write `passphrase.ts`, the `export` and `import` commands, and tests 1, 5, 6 and 7.
3. Write the device flow in the library with its tests, then `auth --device` and `device-auth.test.ts`.
4. Write `docs/server-usage.md` and the SPECS update.
5. `pnpm format`, then `pnpm check`.
6. Ask the owner to confirm the consumer-side issue, create it, and record the date without the repository name.
7. **Owner manual:** create a "TVs and Limited Input devices" client, run `byos auth --device` on any machine, and record the result and the client JSON's top-level key (no secrets).

## Security Considerations
- The export uses scrypt (memory-hard) plus AES-256-GCM, with a random salt and IV and a versioned AAD, and is never plaintext.
- Owner-only files; no overwrite without `--force`; no writing into a pre-existing wider-permission file.
- The passphrase is never echoed and never stored.
- The device code and tokens are never printed; only the user code and verification URL are shown.
- Device-flow scopes are allowlisted like the browser flow.
- No private repository names in this public repo.

## Pattern to Copy
- `packages/cli/src/store/file-token-store.ts` (FN-08) for the envelope and AES-GCM.
- `packages/drive/src/oauth/token-client.ts` (FN-03) for the token endpoint and zod.
- `packages/drive/test/oauth/no-secret-leak.test.ts` for leak tests.

## Verification
- Command: `pnpm check` (green, with the three new test files).
- Manual: the owner's device-flow run recorded.
- Done when: the check is green at the Checkpoint and at the end; `docs/server-usage.md` and the SPECS update are written; the consumer issue is created or explicitly deferred by the owner; the manual run is recorded. The delivery carries the check counts, the mutation result and the verify-it report.

## Out of Scope
- The bill tracker's own code (its repository).
- Encrypting exports to a target key (see the decision above).
- Service-account auth (not compatible with personal `drive.file` use).

## Checkpoint
- `Checkpoint: sim`, after step 1 (export crypto fixed).
