# [FN-08] CLI encrypted token store

## Type
Functional

Checkpoint: sim (security: tokens at rest)

## Description
The CLI keeps the user's Google token on disk, encrypted, in the OS config directory, implementing core's `TokenStore`. This issue also settles SPECS open question 3: where the encryption key comes from on each platform.

## User Flow
1. `byos auth` saves the token; any later command loads it; `byos auth logout` clears it.

## Requirements
- File at `%APPDATA%\byos\tokens\<key>.json` (Windows), `~/Library/Application Support/byos/tokens/` (macOS), `$XDG_CONFIG_HOME/byos/tokens/` or `~/.config/byos/tokens/` (Linux); a `--config-dir` / `BYOS_CONFIG_DIR` override.
- AES-256-GCM via Web Crypto, random 96-bit IV per write, versioned envelope `{ v, iv, ct }`.
- Key source, decided in this issue and recorded here, with a recommendation to evaluate first: `BYOS_TOKEN_KEY` env var (base64, 32 bytes) when set; otherwise a key file generated on first use next to the token directory with owner-only permissions (`0600` on POSIX, an ACL limited to the current user on Windows). OS keychain integration is evaluated but only adopted if it needs no native module.
- Writes are atomic (temp file then rename).
- Wrong key or corrupted file → `AuthError` with reason `missing-token` and a message telling the user to run `byos auth` again; never prints file contents.
- **Security**: the decrypted token exists only in memory; no debug flag prints it.

## Scenarios
### Happy Path
- Save, load, clear round-trip on all three platforms' path rules (path logic unit-tested per platform).
### Edge Cases
- Config directory doesn't exist yet: created with owner-only permissions.
- Two processes saving at once: last atomic write wins, file never half-written.
### Error Handling
- Wrong `BYOS_TOKEN_KEY` → clear `AuthError`.

## Data Requirements
- Envelope format above.

## External Dependencies
- None beyond Node's Web Crypto and `fs`.

## Acceptance Criteria
- [ ] `FileTokenStore` implements `TokenStore`; round-trip test.
- [ ] Ciphertext on disk contains no token substring (asserted).
- [ ] Key-source decision recorded in this issue, with the Windows ACL / POSIX `0600` behavior tested where testable and documented where not.
- [ ] Atomic write tested (crash between temp and rename leaves the old file valid).
- [ ] Wrong key and corrupted file produce the documented error.

## Dependencies
- FN-01.

---

# Implementation Plan

## Key-source decision (owner, 2026-11-21)
- **`BYOS_TOKEN_KEY` env var when set** (base64 of exactly 32 bytes). Otherwise **a key file generated on first use** at `<configDir>/token.key`, next to the `tokens/` directory.
- The OS keychain was evaluated and not adopted: it needs a native module or a platform shell-out per OS, and it doesn't exist on the server (FN-17). A passphrase was also rejected, because it blocks unattended scheduled backups.
- **POSIX:** the key file and token files are created with mode `0600`, and the directories with `0700`. This is tested.
- **Windows:** Node can't set an ACL without a shell-out, so `%APPDATA%\byos` relies on the default per-user ACL of the user profile, which other non-admin users can't read. This is documented in `docs/cli-output.md`-adjacent docs (FN-18) and here, and not tested.
- **The env var wins over the key file.** A wrong env key gives the documented `AuthError`, never a silent fallback to the file.

## Prerequisites
- FN-01 done: `TokenStore`, `StoredToken`, `AuthError` (reason `missing-token`).
- Branch `feat/FN-08-cli-token-store` from an up-to-date `main`. Node 26 in every shell, background ones included.

## Priorities
1. A token never sits on disk in plaintext, and never appears in an error or log.
2. A crash never leaves a half-written token file.
3. Owner-only permissions where the OS lets Node set them.
4. The acceptance criteria.

## Reusable Code Found
- `@byos/core`: `TokenStore`, `StoredToken`, `AuthError`.
- `packages/cli/src/program.ts` and `packages/cli/test/program.test.ts`: the CLI's ESM and test style. The CLI may use Node built-ins (`node:fs/promises`, `node:path`, `node:os`).
- Node's global `crypto.subtle` (Web Crypto) does AES-GCM, as `@byos/drive` already does for SHA-256.

## Knowledge Registry
- **Absence tests** (no plaintext on disk) need a control: the token is really in what was saved.
- **TS 6 Web Crypto** wants `Uint8Array<ArrayBuffer>` (copy external bytes).
- **Background shells start on Node 24.**

## Architecture Decisions
- **Paths (`packages/cli/src/store/paths.ts`):** `configDir({ platform, env, homedir })`, pure and injectable for tests.
  - Windows: `%APPDATA%\byos`.
  - macOS: `~/Library/Application Support/byos`.
  - Linux: `$XDG_CONFIG_HOME/byos`, else `~/.config/byos`.
  - `BYOS_CONFIG_DIR` overrides all of them, and so does the `--config-dir` flag, which FN-09 wires into the program.
  - `tokensDir(configDir)` is `<configDir>/tokens`.
  - `dataDir` is in the same file for FN-12: Windows `%LOCALAPPDATA%\byos`, macOS the same as config, Linux `$XDG_DATA_HOME/byos` or `~/.local/share/byos`, overridden by `BYOS_DATA_DIR`.
- **Key (`packages/cli/src/store/key.ts`):** `loadKey({ configDir, env }): Promise<CryptoKey>`.
  - From the env: decode base64, require exactly 32 bytes, else `AuthError('BYOS_TOKEN_KEY must be base64 of 32 bytes', { reason: 'missing-token' })`.
  - From the file: read `token.key`. If it is missing, generate 32 random bytes and create the file with `open(path, 'wx', 0o600)`. On `EEXIST` (another process won the race), read it.
  - Import with `crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt'])`, which is non-extractable.
- **Store (`packages/cli/src/store/file-token-store.ts`):** `class FileTokenStore implements TokenStore`, constructed with `{ configDir, env? }`.
  - The token key name must match `/^[A-Za-z0-9._-]{1,64}$/`, else `ProviderError(..., { retryable: false })`. This prevents path traversal through the key.
  - **The file** is `<tokensDir>/<key>.json`, a versioned envelope `{ "v": 1, "iv": "<base64 12 bytes>", "ct": "<base64>" }`.
  - **Encryption** is `AES-GCM`, with a fresh 96-bit IV per write and `additionalData` = UTF-8 of the key name, so a file renamed to another key fails to decrypt. The plaintext is `JSON.stringify(token)`.
  - `load(key)`:
    - a missing file gives `undefined`;
    - a bad JSON envelope, an unknown `v`, a decrypt failure (wrong key or tampering) or a decrypted payload that isn't a `StoredToken` give `AuthError("the stored sign-in can't be read (wrong key or damaged file); run byos auth again", { reason: 'missing-token' })`, never with file contents or a `cause`;
    - the payload is validated with a small hand check of the required fields (no zod needed in the CLI yet).
  - `save(key, token)`: `mkdir(tokensDir, { recursive: true, mode: 0o700 })`, then an atomic write.
  - `clear(key)`: `rm` that ignores `ENOENT`.
- **Atomic write (`packages/cli/src/store/atomic-write.ts`):** `writeFileAtomic(path, data, hooks?)`.
  - It writes `<path>.<random hex>.tmp` with `{ mode: 0o600, flag: 'wx' }`, runs `filehandle.sync()`, closes it, then `rename` to `path`.
  - `hooks.beforeRename` is an internal test hook to simulate a crash between write and rename. On any error the temp file is removed (best effort).
  - `load` ignores stray `*.tmp` files.
- **Checkpoint after the store:** run `pnpm check` once crypto and atomic write are in place, because this is the security surface.

## Files to Create
| File | Purpose |
|------|---------|
| `packages/cli/src/store/paths.ts` | `configDir`, `tokensDir`, `dataDir` per platform with overrides |
| `packages/cli/src/store/key.ts` | `loadKey` (env, else key file 0600) |
| `packages/cli/src/store/atomic-write.ts` | `writeFileAtomic` |
| `packages/cli/src/store/file-token-store.ts` | `FileTokenStore` |
| `packages/cli/test/store/paths.test.ts` | Path rules per platform and overrides |
| `packages/cli/test/store/file-token-store.test.ts` | Round-trip, no plaintext, wrong key, corruption, key-name validation, permissions, atomicity, concurrency |

## Files to Modify
| File | Changes |
|------|---------|
| `issues/FN-08-cli-token-store.md` | Execution Record |
| `issues/_index.md` | FN-08 `todo` → `planned` now; `done` only by verify-it |

Don't touch `program.ts`: wiring the store into commands is FN-09.

## Data Requirements
- Files: `<configDir>/token.key` (base64, 0600) and `<configDir>/tokens/<key>.json` (envelope, 0600).

## Testing Strategy
- Every test uses a fresh `fs.mkdtemp(join(os.tmpdir(), 'byos-'))` as the config dir, removed in `afterEach`, and passes `env: {}` unless it is testing the env path.
- `paths.test.ts`: win32 with `APPDATA`, darwin, linux with and without `XDG_CONFIG_HOME`, the `BYOS_CONFIG_DIR` override, and the data dir rules.
- `file-token-store.test.ts`:
  1. Save, load and clear round-trip; load after clear gives `undefined`.
  2. **No plaintext:** the raw file contains neither `accessToken`, nor `refreshToken`, nor their base64. Control: the token loads back equal.
  3. A wrong env key (another valid 32-byte key) gives `AuthError` `missing-token` with no file contents in the message.
  4. An env key of the wrong length gives `AuthError`.
  5. A corrupted file (flip a byte of `ct`, or plain garbage) gives `AuthError`.
  6. A file copied to another key name fails (AAD).
  7. Key names `../x` and `a/b` are refused.
  8. POSIX (`it.skipIf(process.platform === 'win32')`): `token.key` and the token file have mode `0600`, the dirs `0700`.
  9. **Atomic:** save v1, then save v2 with `beforeRename` throwing. Load returns v1 intact, and no `*.tmp` is left.
  10. Two concurrent saves of different tokens: load returns one of them whole, never a decrypt error.
  11. Two concurrent first-use key creations converge on one key, and both stores read each other's tokens.

## Implementation Order
1. **Riskiest first:** `key.ts` and `file-token-store.ts` crypto with the envelope, then tests 1–6. **Checkpoint: `pnpm check`.**
2. `atomic-write.ts`, then tests 9–11.
3. `paths.ts` and its tests; permissions test 8; key-name validation test 7.
4. `pnpm format`, then `pnpm check`.

## Security Considerations
- AES-256-GCM, a fresh IV per write, AAD bound to the key name, and a non-extractable `CryptoKey`.
- No plaintext on disk and no file contents in errors; the token exists decrypted only in memory.
- Owner-only permissions on POSIX; the Windows behavior is documented.
- The key name is validated against path traversal.

## Pattern to Copy
- `packages/cli/test/program.test.ts` for the test file style.
- `packages/drive/src/oauth/token-manager.ts` for how a `TokenStore` is consumed (load, save, clear).

## Verification
- Command: `pnpm check` (green, with the two new CLI test files).
- Done when: the check is green at the Checkpoint and at the end. The delivery carries the check counts per step and the verify-it report.

## Out of Scope
- Commands (`byos auth`, `logout`) and the `--config-dir` flag wiring (FN-09).
- Export and import of tokens (FN-17).
- OS keychain integration.

## Checkpoint
- `Checkpoint: sim`, after step 1 (crypto and envelope fixed).
