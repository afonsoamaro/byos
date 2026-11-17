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
