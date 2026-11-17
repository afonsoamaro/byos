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
4. The bill tracker calls `byos put <pdf> --remote "Bills to Pay/<YYYY-MM>" --mkdir --if-absent --json`.

## Requirements
- First, check whether Google's limited-input device flow accepts `drive.file`; record the answer here with the source. If it does, offer `byos auth --device` as an alternative; export/import is still implemented, as it works offline.
- Export file encrypted (AES-256-GCM, key derived from a passphrase with a strong KDF, or the target key); never plaintext; import validates and stores through FN-08.
- `docs/server-usage.md`: install on a server, token import, env vars, the `--json` contract and exit codes (from FN-11), and retry guidance (`--if-absent` makes retries safe).
- **Security**: the export file is a credential; docs say so, recommend deleting it after import, and the CLI refuses to write it with permissions wider than owner-only.
- Bill tracker side (not this repo): the call runs in a background task after decrypt; failure marks the file "archive pending" and never blocks ingestion; only the decrypted PDF goes to Drive under `Bills to Pay/<YYYY-MM>/`; a one-off backfill sends existing PDFs. Create that issue in the bill tracker's repo after owner confirmation and link it here.

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
