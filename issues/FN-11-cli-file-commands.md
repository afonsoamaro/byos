# [FN-11] CLI file commands with `--json`

## Type
Functional

## Description
Thin commands over the provider: `byos ls`, `stat`, `get`, `put`, `mkdir`, `mv`, `cp`, `rm`. Their `--json` mode is the contract the bill tracker (a Python app) uses through a subprocess, so the output and exit codes are treated as a public API.

## User Flow
1. `byos put ./out/2026-11/nubank.pdf --remote "Bills to Pay/2026-11" --mkdir --json`
2. Prints `{ "id": "...", "name": "nubank.pdf", "sha256": "...", "size": 123, "path": "Bills to Pay/2026-11/nubank.pdf" }` on stdout, exit 0.
3. On failure prints `{ "code": "QUOTA_EXCEEDED", "message": "..." }` on stderr, exit non-zero.

## Requirements
- Remote arguments accept a path (relative to the configured root, default Drive root) or `id:<fileId>`.
- `put`: streams the local file, computes SHA-256 while reading, uses simple or resumable upload by size; `--mkdir` creates the remote folder; `--overwrite` maps to provider `overwrite`; **idempotent mode** `--if-absent`: when a file with the same name and the same `byosSha256` exists, return it without uploading (exit 0). This is what lets the bill tracker retry safely.
- `get <remote> [local]`: streams to a file or stdout; refuses to overwrite a local file without `--force`.
- `ls` lists children; `stat` prints one `FileStat`; `mv`, `cp`, `rm [--permanent]` map to FN-07.
- Exit codes: 0 success; 2 usage error; 3 not found; 4 conflict; 5 auth; 6 quota; 7 rate limited after retries; 1 anything else. Documented in `docs/cli-output.md`.
- `--json` writes only JSON to stdout (no progress, no color); human output follows PP-02.

## Scenarios
### Happy Path
- `put` then `stat` then `get` round-trips a file with matching SHA-256.
### Edge Cases
- `put --if-absent` twice: second call uploads nothing and returns the same ID.
- Windows paths with backslashes and spaces as local arguments.
### Error Handling
- Each error class maps to its exit code and JSON `code`.

## Data Requirements
- None.

## External Dependencies
- None new.

## Acceptance Criteria
- [ ] All eight commands work against the in-memory fake provider through the real CLI entry point (spawned process in tests).
- [ ] `--json` output and exit codes match the documented table, tested per error.
- [ ] `put --if-absent` is idempotent (tested).
- [ ] `get` refuses to overwrite without `--force`.

## Dependencies
- FN-07, FN-09.
