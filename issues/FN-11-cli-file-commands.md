# [FN-11] CLI file commands with `--json`

## Type
Functional

## Description
Thin commands over the provider: `byos ls`, `stat`, `get`, `put`, `mkdir`, `mv`, `cp`, `rm`. Their `--json` mode is the contract the bill tracker (a Python app) uses through a subprocess, so the output and exit codes are treated as a public API.

## User Flow
1. `byos put ./out/2026-11/statement.pdf --remote "Archive/2026-11" --mkdir --json`
2. Prints `{ "id": "...", "name": "statement.pdf", "sha256": "...", "size": 123, "path": "Archive/2026-11/statement.pdf" }` on stdout, exit 0.
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

---

# Implementation Plan

## Prerequisites
- FN-07 and FN-09 done:
  - `DriveProvider` with all eight operations, `resumeUpload` and `account()`;
  - the shared `storageContract` in `@byos/core/testing`;
  - the CLI skeleton (`main`, `output.ts`, `errors.ts` with `exitCodeFor` and `report`, `config.ts`, `context.ts`) and the CLI test helpers.
- `docs/cli-output.md` (PP-02) fixes the `--json` shapes for `ls`, `put` and errors, and the exit-code table.
- Branch `feat/FN-11-cli-file-commands` from an up-to-date `main`. Node 26 in every shell, background ones included.

## Priorities
1. **The `--json` output and exit codes are a public API** for a subprocess consumer. Stdout carries exactly one JSON document on success, stderr one `{ code, message }` on failure, and nothing else.
2. Never destroy local or remote data by accident:
   - `get` doesn't overwrite a local file without `--force`;
   - `put` doesn't replace a remote file without `--overwrite`;
   - `rm` trashes unless `--permanent`.
3. The acceptance criteria.

## Reusable Code Found
- `packages/cli/src/context.ts` (FN-09): `openContext(io, flags)` gives the provider and output.
- `packages/cli/src/errors.ts`: `exitCodeFor` and `report`.
- `packages/cli/src/output.ts`: human versus `--json`.
- `@byos/core/testing`: `MemoryProvider`, the in-memory fake that the acceptance criteria ask the commands to run against.
- `scripts/cli-output-mock.ts`: the exact `ls-json`, `put-json` and error shapes and wording.

## Knowledge Registry
- **Spawning one process per test case** times out under load. Commands are tested in-process through `main()`, which is the same function `bin.ts` calls. A single spawned smoke already exists from FN-09.
- **Background shells start on Node 24.**

## Architecture Decisions
- **Testing against the in-memory fake:**
  - `CliIO` (FN-09) gains an optional `createProvider?: (ctx) => StorageProvider & Partial<Pick<DriveProvider, 'resumeUpload'>>`;
  - `realIO()` leaves it unset, so `context.ts` builds the `DriveProvider`;
  - tests pass `() => memoryProvider`;
  - this is a dependency-injection seam on the in-process `main()`, never an env var or a hidden flag in the shipped binary;
  - **deviation from the issue text:** the eight commands are exercised in-process through `main()`, not one spawned process per command. The spawned smoke (FN-09) still covers the real entry point.
- **Remote references (`packages/cli/src/remote.ts`):**
  - `id:<fileId>` gives `{ id }`;
  - anything else gives `{ path }`, POSIX and relative to the configured root;
  - backslashes in a remote argument are rejected with `CliError` (exit 2) "remote paths use /";
  - `remotePathOf(stat, parentPath)` builds the `path` shown in JSON.
- **Local paths:** they are resolved with Node's `path` for the running platform (`io.platform` picks `path.win32` or `path.posix` in a helper, so tests can cover Windows rules). Names with spaces and backslash paths on Windows are handled by `path.win32.basename` and `resolve`.
- **`put <local> --remote <dir> [--name <n>] [--mkdir] [--overwrite] [--if-absent] [--json]`:**
  1. `stat` the local file: it must exist and be a regular file, else `CliError` exit 2. Its `size` comes from the stat.
  2. **Hash first**, streaming with `node:crypto` `createHash('sha256')` over `fs.createReadStream`. This is one read pass, and resumable uploads need the hash up front (FN-06).
  3. `--mkdir`: `provider.mkdir({ parent: { path: dirname(dir) }, name: basename(dir), parents: true })`, or the root when `dir` is empty.
  4. **`--if-absent`:** `stat({ path: dir/name })`. If it exists and its `sha256` equals the local one, print it and exit 0 with **no upload**. If it exists with another hash, give `ConflictError` (exit 4) unless `--overwrite` is also set.
  5. `put({ parent: { path: dir }, name, body: Readable.toWeb(createReadStream(file)), size, sha256, overwrite })`. The provider picks simple or resumable.
  6. Print the human line, or `--json` `{ id, name, sha256, size, path }`.
- **`get <remote> [local|-] [--force] [--json]`:**
  - With no local path, or `-`, it streams to stdout. That can't be combined with `--json` (exit 2).
  - Otherwise it opens the local file with flag `'wx'`, so an existing file gives `CliError` exit 4 "already exists; use --force". With `--force` the flag is `'w'`.
  - It pipes `Readable.fromWeb(stream)` to the file with `pipeline`. On error it removes the partial file.
  - `--json` gives `{ id, name, size, path: <local absolute> }`.
- **`ls [remote] [--json]`:**
  - it reads all pages (`pageToken` loop, `pageSize: 1000`);
  - human output is one line per item with the kind marker and the size;
  - `--json` is an array of `{ id, name, path, kind: 'file' | 'folder', size?, modifiedTime?, sha256? }`, the PP-02 `ls-json` shape, mapped from `FileStat` (`modifiedAt` → `modifiedTime`).
- **`stat <remote> [--json]`:** the same object shape. `undefined` gives `NotFoundError` → exit 3.
- **`mkdir <remote> [--parents]`:** `provider.mkdir`. `--json` prints the folder object.
- **`mv <remote> <dest>` and `cp <remote> <dest>`:**
  - `dest` is a full target path;
  - a trailing `/` means "into this folder, keep the name";
  - the parent is `dirname(dest)` and the name is `basename(dest)`;
  - this maps to `provider.move(ref, { parent, name })` and `provider.copy(ref, { parent, name })`;
  - `--json` prints the resulting object.
- **`rm <remote> [--permanent]`:** `provider.delete(ref, { permanent })`. `--json` prints `{ id, trashed: !permanent }`.
- **Errors:** every command funnels through `report` and `exitCodeFor`, so the table is enforced in one place. The bill tracker relies on `AUTH_FAILED` (exit 5) carrying `reason` in the JSON when present. `report` adds `reason` for `AuthError`, since `ByosError.toJSON` already includes it.
- **`docs/cli-output.md`:**
  - add `stat-json`, `mkdir-json` and `rm-json` scenarios to `scripts/cli-output-mock.ts`, and regenerate;
  - the exit-code table there is already this one, and a test asserts `exitCodeFor` against the same table.

## Files to Create
| File | Purpose |
|------|---------|
| `packages/cli/src/remote.ts` | Remote argument parsing and path display |
| `packages/cli/src/local.ts` | Platform path helpers, streaming SHA-256 of a local file |
| `packages/cli/src/commands/files.ts` | `ls`, `stat`, `get`, `put`, `mkdir`, `mv`, `cp`, `rm` |
| `packages/cli/test/files.test.ts` | Every command against `MemoryProvider` through `main()` |
| `packages/cli/test/exit-codes.test.ts` | One case per error class: human and `--json` output plus the exit code |

## Files to Modify
| File | Changes |
|------|---------|
| `packages/cli/src/main.ts` | `CliIO.createProvider` seam |
| `packages/cli/src/context.ts` | Use `io.createProvider` when present |
| `packages/cli/src/program.ts` | Register the eight commands |
| `packages/cli/src/errors.ts` | Include `reason` in the JSON error when present |
| `scripts/cli-output-mock.ts` | `stat-json`, `mkdir-json`, `rm-json` scenarios |
| `docs/cli-output.md` | Regenerated |
| `issues/FN-11-cli-file-commands.md` | Execution Record |
| `issues/_index.md` | FN-11 `todo` → `planned` now; `done` only by verify-it |

## Data Requirements
- None.

## Testing Strategy
- `files.test.ts` uses a temp working dir, `memoryIO({ createProvider: () => mem })` and `mem = new MemoryProvider()`:
  1. `put` then `stat` then `get` round-trips a file. The SHA-256 of the downloaded file equals the local one, and `--json` shapes match PP-02.
  2. `put --mkdir --remote Archive/2026-11 --json` creates the folders and prints `path: 'Archive/2026-11/statement.pdf'`.
  3. **`put --if-absent` twice:** the second run makes no upload (`mem.calls.put` unchanged) and returns the same id. With different content and `--if-absent` it gives exit 4.
  4. `put` onto an existing name without `--overwrite` gives exit 4; with it, the same id.
  5. `put` of a local file over 5 MiB passes `sha256` and `size` (asserted with a spy provider wrapping `mem`).
  6. `get` refuses an existing local file (exit 4) and succeeds with `--force`; `get -` writes the bytes to stdout.
  7. `ls` over 3 pages (`MemoryProvider` with more than 1000 children isn't needed: spy on `list` to force `nextPageToken`) returns all items.
  8. `mv`: rename, move into a folder with a trailing `/`, and a clash gives exit 4.
  9. `cp` gives a new id with the same `sha256`; `cp` of a folder gives exit 1.
  10. `rm` trashes (the item is gone from `stat`, and `snapshot()` shows `trashed`); `rm --permanent` removes it.
  11. Local paths with spaces; a Windows-style local path under `io.platform = 'win32'` resolves its basename correctly (pure helper test in `local.ts`).
  12. `id:<id>` references work for `stat`, `get` and `rm`.
- `exit-codes.test.ts`: `mem.failNext(op, error)` for `NotFoundError` (3), `ConflictError` (4), `AuthError` (5, with `reason` in the JSON), `QuotaExceededError` (6), `RateLimitError` (7), `ProviderError` (1), plus a usage error (2). Each case checks that `--json` writes nothing to stdout and exactly one `{ code, message }` line to stderr, and that human mode writes a `✗ CODE:` line.
- The drift test for `docs/cli-output.md` stays green after regenerating.

## Implementation Order
1. **Riskiest first, the JSON and exit-code contract.** Write `remote.ts`, the provider seam, `stat` and `put` (with the hash, `--if-absent` and `--json`), and `exit-codes.test.ts`. This is the public API the bill tracker depends on.
2. Write `get` (streams, `--force`), `ls` (pagination), `mkdir`, `mv`, `cp` and `rm`.
3. Write the rest of `files.test.ts`.
4. Update the mock scenarios and regenerate the doc.
5. `pnpm format`, then `pnpm check`.

## Security Considerations
- No token in any output. Error JSON is `toJSON()` (no `cause`, no `stack`).
- `get` never overwrites without `--force`, `put` never replaces without `--overwrite`, and `rm` trashes by default.
- Local file writes use exclusive create (`'wx'`) to avoid races with an existing file.

## Pattern to Copy
- `packages/cli/src/commands/auth.ts` (FN-09) for command structure.
- `scripts/cli-output-mock.ts` for the JSON shapes and wording.

## Verification
- Command: `pnpm check` (green, with `files.test.ts`, `exit-codes.test.ts` and the doc drift test).
- Done when: the check is green. The delivery carries the check counts and the verify-it report.

## Out of Scope
- `backup` (FN-12 to FN-14), headless auth (FN-17), and recursive copy or move of folders.

## Checkpoint
- `Checkpoint: sim`, after step 1: the `--json` and exit-code contract is a public API; run `pnpm check` once it passes.

---

# Execution Record

- Branch `feat/FN-11-cli-file-commands`, executed 2026-11-22.
- Step 1 (riskiest) and Checkpoint: `remote.ts`, the provider seam (`CliIO.createProvider`, used only by tests), `local.ts` and the eight commands, with `exit-codes.test.ts` proving the table first: each error class gives its exit code and its JSON `code`, with nothing on stdout and exactly one `{ code, message }` line on stderr under `--json`, `✗ CODE: message` in human mode, the `reason` of an auth error in the JSON, a usage mistake as exit 2, and exit 5 with no sign-in at all. `pnpm check` was run at the Checkpoint (it caught three lint errors, fixed).
- **Security review during execution:** an automated review flagged that `byos get <remote> <folder>` used the remote name as the local file name, and Drive allows names like `../x`. `safeLocalName` (in `local.ts`) replaces separators (on Windows also `<>:"|?*` and control characters, `:` being an NTFS alternate data stream), refuses `.`, `..` and an empty name, and a second check confirms the result stays inside the folder. Tested with remote files named `../escape.txt`, `..` and `.`; the mutation that uses the name as is fails the test.
- The test of that second check found a bug in it: `relative.startsWith('..')` rejected the sanitised name `.._escape.txt`; only a first segment of exactly `..` leaves the folder.
- Mutation proofs (restored, `cmp` equal): the remote name used as is fails the traversal test; `get` that always overwrites fails two tests (the `--force` rule and saving into a folder).
- Deviations from the plan:
  - `stat`, `ls`, `mkdir`, `mv` and `cp` print `path` only when the file was reached by path; a file reached by `id:<fileId>` has none (Drive ids carry no path). Documented in `docs/cli-output.md`.
  - `put --remote` accepts `id:<folderId>` as well; `--mkdir` is then ignored, and `--if-absent` lists the folder instead of looking the path up.
  - `byos get` to stdout needs a sink that takes bytes (`Sink.writeBytes`, set by the real binary and by the test sink).
  - `rm` looks the file up first (a path ref needs its id for the JSON); an `id:` ref goes straight to the provider, so an already-trashed file can still be deleted for good.
  - `mv` and `cp` take a full destination path, with a trailing `/` meaning "into that folder"; an `id:` destination is refused.
  - The PP-02 mock's examples (`Bills/2026-11`) became `Archive/2026-11`, matching the issues, and the doc gained `stat-json`, `mkdir-json` and `rm-json`.
- **verify-it round 1: 92, no vetoes.** Fixed from its findings: local disk errors in `get` and `put` surfaced as `UNEXPECTED` (now `USAGE` for a missing or unusable path, `LOCAL_IO` for permission, disk full and read-only, documented in `docs/cli-output.md`); the exit-code table was only driven through `stat` (added `put` and `rm` cases); Windows reserved names (`CON`, `NUL.txt`) and trailing dots and spaces in `safeLocalName`; `put --name` with folders, `.` or `..` is a usage error; an obfuscated `3 - 3 + 4` in a test; a pointer comment on the `fmtBytes` copy in the mock script.
- Not done, by choice: `get --force` still truncates the old file before the download (the overwrite is explicit; a temp-file-and-rename is a good follow-up); `files.ts` stays at about 400 lines, one responsibility (the eight commands); progress lines for `put` and `get` stay with a later issue.
- `BYOS_TEST_TIMEOUT=300000 pnpm check`: build, lint (ESLint 0 warnings, Prettier clean), typecheck and tests green: 435 passed after the verifier fixes (83 in core, 162 in drive, 161 in cli, 29 in the root suite).
- **Security review after the PR was opened:** remote file names printed in human output could carry terminal escape sequences (`ESC[2J` and similar). `printable()` in `format.ts` now replaces control characters with `?` in `ls`, `stat`, and the `put`, `get`, `mkdir`, `mv`, `cp` messages, and in the error line; `--json` keeps the real name (JSON-escaped). Tested with a remote name containing ESC and BEL; the mutation that prints the raw name in `ls` fails the test.
