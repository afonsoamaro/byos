# [FN-12] `byos backup`: scan, manifest and plan

## Type
Functional

## Description
First half of backup: walk the local folder, compare with a local manifest, and produce the upload plan. Ends with `byos backup <folder> --dry-run` working; no uploads yet.

## User Flow
1. `byos backup C:\Users\me\Pictures --dry-run`
2. Prints the scan summary and the list of files that would upload (PP-02 format).

## Requirements
- Remote layout: `<remote-root>/<device>/<folder name>/<relative path>`, `--remote-root` default `BYOS Backup`, `--device` default hostname (sanitized).
- Include every regular file; skip `Thumbs.db`, `desktop.ini`, `.DS_Store`, `._*`, hidden files and directories, symlinks (not followed, reported as skipped), and `--exclude <glob>` (repeatable).
- Manifest in `node:sqlite`, one database per (absolute local folder, device, remote root), in the OS data directory. Table `files(rel_path PRIMARY KEY, size, mtime_ms, sha256, drive_id, uploaded_at)`, table `folders(rel_path PRIMARY KEY, drive_id)`, table `sessions(rel_path PRIMARY KEY, session_uri, offset, size, sha256, started_at)` (used by FN-13). Schema version table with forward migrations.
- Change detection: same size and mtime as the manifest → unchanged, no hashing. Otherwise hash (streaming SHA-256); same hash → update mtime only; different hash or not in manifest → plan upload (new file or new revision of the stored `drive_id`).
- Relative paths stored as POSIX with Unicode NFC normalization; case-insensitive collisions on Windows/macOS are detected and reported (two entries differing only by case on a case-sensitive source).
- Files deleted locally stay in the manifest and are never planned for deletion (additive backup).
- **Security**: the manifest stores the resumable session URI (a secret, see FN-06); the database file is created with owner-only permissions.

## Scenarios
### Happy Path
- First dry run over 1,000 files plans 1,000 uploads; after marking them uploaded in the manifest (test helper), a second run plans 0 and hashes nothing.
### Edge Cases
- Touching a file (mtime change, same content) rehashes it and plans nothing.
- Deep paths over 260 chars on Windows (use the Node path handling that supports long paths; test on the path logic).
- File disappears between scan and hash: skipped with a warning.
### Error Handling
- Unreadable file (permissions): reported, the run continues, exit non-zero at the end.

## Data Requirements
- Manifest schema above.

## External Dependencies
- `node:sqlite` (built into Node 26).

## Acceptance Criteria
- [ ] `--dry-run` prints the plan in PP-02 format and touches neither Drive nor the manifest's upload columns.
- [ ] Unchanged files are skipped without hashing (asserted by counting hash calls).
- [ ] Skip rules and `--exclude` tested.
- [ ] No-change re-run over 20,000 generated files completes in under 30 s locally (measured and recorded here).
- [ ] Manifest database created with owner-only permissions; schema version recorded.

## Dependencies
- FN-11.

---

# Implementation Plan

## Prerequisites
- FN-11 done: CLI skeleton, `local.ts` (platform paths and streaming SHA-256 with `node:crypto`), `remote.ts`, `context.ts` with the `createProvider` seam, and the CLI test helpers.
- FN-08 done: `paths.ts` with `dataDir()` (`BYOS_DATA_DIR` override).
- `node:sqlite` is available in Node 26 (`DatabaseSync`, SQLite 3.54.1, checked 2026-11-21).
- Add `picomatch` `4.0.7` (latest, checked 2026-11-21) to `packages/cli` `dependencies`, exact, for `--exclude` globs: `pnpm --filter @byos/cli add picomatch@4.0.7 --save-exact`, plus `@types/picomatch` as a dev dependency at its latest version checked with `npm view` at execution. Stage `pnpm-lock.yaml`.
- Branch `feat/FN-12-backup-scan` from an up-to-date `main`. Node 26 in every shell, background ones included.

## Priorities
1. Additive and safe: never plan a deletion, and never write the manifest's upload columns in a dry run.
2. A no-change re-run is cheap: no hashing when size and mtime match.
3. The acceptance criteria, including the measured 20,000-file run.

## Reusable Code Found
- `packages/cli/src/local.ts` (FN-11): the streaming SHA-256 of a local file.
- `packages/cli/src/store/paths.ts` (FN-08): `dataDir`.
- `packages/cli/src/store/atomic-write.ts`: not needed (SQLite handles its own writes), listed so it isn't reimplemented.
- `scripts/cli-output-mock.ts`: the `backup-dry-run` scenario holds the exact plan output (the scan summary and "Would upload N files").
- `packages/core/src/path-resolver.ts`: `normalizePath`, for NFC and POSIX segment rules. The manifest's relative paths use the same normalization.

## Knowledge Registry
- **Spawning per test** times out under load: test in-process. A long benchmark stays out of the gate.
- **Background shells start on Node 24.**

## Architecture Decisions
- **Modules in `packages/cli/src/backup/`:**
  - `device.ts`: `deviceName(hostname)` replaces any character outside `[A-Za-z0-9._ -]` with `-`, trims, and falls back to `device` when the result is empty.
  - `scan.ts`: `scan(root, { exclude, platform })` is an async generator of `{ relPath, absPath, size, mtimeMs }` plus a `skipped` report.
    - It recurses with `fs.opendir` and `lstat`.
    - Symlinks are not followed and are reported as `skipped: symlink`.
    - Skipped: `Thumbs.db`, `desktop.ini`, `.DS_Store`, `._*`, any file or directory whose name starts with `.`, and `--exclude` globs (picomatch with `{ dot: true }`, matched against the POSIX relative path).
    - `relPath` uses POSIX separators and NFC (`normalize('NFC')` per segment). A case-insensitive collision (two relative paths whose lowercase forms are equal) is reported as a warning, and both are kept, since Drive is case-sensitive.
    - The Windows hidden attribute can't be read from Node without a native call, so only dot-prefixed names and the listed system files are skipped. Recorded here.
  - `manifest.ts`: `openManifest({ dataDir, folder, device, remoteRoot })`.
    - The file is `<dataDir>/manifests/<first 16 hex of sha256(abs folder + '\0' + device + '\0' + remoteRoot)>.sqlite`.
    - The directory is created with `0700`. The file is pre-created with `open(..., 'wx', 0o600)` when missing, then opened with `new DatabaseSync(path)`, with `journal_mode=DELETE` (no WAL side files).
    - Tables:
      - `meta(key PRIMARY KEY, value)`, holding `schema_version`, `folder`, `device` and `remote_root`;
      - `files(rel_path PRIMARY KEY, size, mtime_ms, sha256, drive_id, uploaded_at)`;
      - `folders(rel_path PRIMARY KEY, drive_id)`;
      - `sessions(rel_path PRIMARY KEY, session_uri, offset, size, sha256, started_at)`.
    - **Forward migrations:** an ordered array `MIGRATIONS[i]` of SQL, applied when `schema_version < i + 1`, in a transaction. v1 is the schema above.
    - The API is narrow and synchronous (`DatabaseSync`): `get(relPath)`, `touchMtime(relPath, mtimeMs)`, `recordUpload(relPath, { size, mtimeMs, sha256, driveId })`, `folderId` / `setFolderId`, `session` / `setSession` / `clearSession` (for FN-13), and `close()`.
  - `plan.ts`: `planBackup({ scan, manifest, hash, dryRun })` returns `{ found, unchanged, toUpload: PlanItem[], bytes, skipped, warnings, errors }`, where `PlanItem` is `{ relPath, absPath, size, mtimeMs, sha256, driveId? }`.
    - Same size and mtime as the manifest: `unchanged`, with no hash.
    - Otherwise hash it. The same hash: `unchanged`, and when not a dry run, `touchMtime`. A different hash or no row: `toUpload` (with `driveId` when the row has one, so FN-13 uploads a revision).
    - `hash` is injected (default: `local.ts` streaming SHA-256), so tests count the calls.
    - `ENOENT` between scan and hash adds a warning and skips; `EACCES` / `EPERM` go to `errors`, and the run continues.
    - Local deletions are never planned: rows for missing files stay untouched.
- **`byos backup <folder> [--device <name>] [--remote-root <name>] [--exclude <glob>...] [--dry-run] [--json]`** (`packages/cli/src/commands/backup.ts`):
  - the folder is resolved to an absolute path and must be a directory, else exit 2;
  - `--remote-root` defaults to `BYOS Backup`, and `--device` to `deviceName(os.hostname())`;
  - `--dry-run` prints the PP-02 `backup-dry-run` output: the scan summary, the remote path `<root>/<device>/<folder name>`, and up to 6 example paths plus "… and N more". It writes nothing to the upload columns (it doesn't even `touchMtime`), and nothing goes to Drive;
  - **without `--dry-run`**, in this issue: `CliError('uploading arrives with the next release; use --dry-run', 2)`. FN-13 replaces it;
  - `--json` with `--dry-run` gives `{ found, unchanged, toUpload, bytes, skipped, warnings, errors }`, with the arrays of relative paths;
  - the exit code is 1 when `errors` is non-empty, else 0.
- **Performance measurement:** `scripts/bench-backup-scan.ts`, run with `node scripts/bench-backup-scan.ts`, is outside the gate.
  - It generates 20,000 small files in a temp dir, runs a first plan, records them all in a temp manifest, runs a second plan and reports its duration and the hash count.
  - The acceptance criterion's "under 30 s" is measured by this script, and the number goes into the Execution Record. The gate test uses 1,000 files.
  - Root `tsconfig.json` already includes `scripts/` (PP-02), with `erasableSyntaxOnly`.

## Files to Create
| File | Purpose |
|------|---------|
| `packages/cli/src/backup/device.ts` | Device name sanitization |
| `packages/cli/src/backup/scan.ts` | Folder walk with skip rules |
| `packages/cli/src/backup/manifest.ts` | SQLite manifest with migrations |
| `packages/cli/src/backup/plan.ts` | Change detection and upload plan |
| `packages/cli/src/commands/backup.ts` | `byos backup` (dry run in this issue) |
| `packages/cli/test/backup/scan.test.ts` | Skip rules, excludes, symlinks, NFC, case collisions |
| `packages/cli/test/backup/manifest.test.ts` | Schema, migrations, permissions, per-key file naming |
| `packages/cli/test/backup/plan.test.ts` | 1,000-file first plan, no-hash second plan, touch, change, disappearing and unreadable files |
| `packages/cli/test/backup/command.test.ts` | `backup --dry-run` human and `--json` output through `main()` |
| `scripts/bench-backup-scan.ts` | 20,000-file measurement |

## Files to Modify
| File | Changes |
|------|---------|
| `packages/cli/src/program.ts` | Register `backup` |
| `packages/cli/package.json` | `picomatch`, `@types/picomatch` |
| `pnpm-lock.yaml` | Install |
| `issues/FN-12-backup-scan-and-manifest.md` | Execution Record with the benchmark result |
| `issues/_index.md` | FN-12 `todo` → `planned` now; `done` only by verify-it |

## Data Requirements
- The manifest schema v1 described above, in `<dataDir>/manifests/<key>.sqlite` (0600, in a dir with 0700).

## Testing Strategy
- Temp folders built per test, and `BYOS_DATA_DIR` set to a temp dir.
- `scan.test.ts`:
  - each skip rule (`Thumbs.db`, `desktop.ini`, `.DS_Store`, `._x`, `.hidden/`, a dot-file);
  - `--exclude '**/*.tmp'` and `--exclude 'raw/**'`;
  - a symlink to a file and to a dir are both reported as skipped and not followed (`it.skipIf(win32)` where symlink creation needs privileges);
  - an NFD file name gives an NFC `relPath`;
  - `A.jpg` and `a.jpg` on a case-sensitive temp FS give a warning, skipped when the FS is case-insensitive;
  - nested dirs give POSIX `relPath`s.
- `manifest.test.ts`:
  - a fresh DB has `schema_version` 1 and the four tables;
  - reopening keeps the data;
  - a migration array with a fake v2 applies once;
  - POSIX file mode is `0600` and the dir `0700`;
  - different `(folder, device, remoteRoot)` give different files.
- `plan.test.ts`:
  1. 1,000 files: the first plan gives 1,000 `toUpload` and 1,000 hash calls. After `recordUpload` for all, the second plan gives 0 `toUpload` and **0 hash calls**.
  2. `utimes` on one file with the same content gives 1 hash, 0 `toUpload`, and its mtime updated. A dry run gives no update.
  3. Changed content with a stored `driveId` gives a `toUpload` item carrying that `driveId`.
  4. A file deleted between scan and hash (inject a `hash` that throws `ENOENT`) gives a warning and the run continues.
  5. A file that can't be read (chmod 000, POSIX) goes to `errors`, with exit 1 at the command level.
  6. Files deleted locally that remain in the manifest produce no plan entry.
  7. The dry run leaves the `files` table byte-identical (compare `SELECT *` before and after).
- `command.test.ts`:
  - the human dry-run output matches the PP-02 shape;
  - `--json` gives the plan object;
  - without `--dry-run` it exits 2 with the message;
  - a missing folder exits 2.
- **Benchmark:** run `node scripts/bench-backup-scan.ts` once at delivery and record "N files, first plan X s, no-change re-run Y s, hash calls Z".

## Implementation Order
1. **Riskiest first, the manifest and the no-hash rule.** Write `manifest.ts` (schema, migrations, permissions) and `plan.ts` with an injected hasher, then run `plan.test.ts` cases 1 and 7. This is the performance and safety core.
2. Write `scan.ts` with the skip rules and `scan.test.ts`.
3. Write `device.ts`, the command, and `command.test.ts`.
4. Write the benchmark script and record the measurement.
5. `pnpm format`, then `pnpm check`.

## Security Considerations
- The manifest will hold resumable session URIs (bearer-like, FN-06/FN-13), so the DB file is `0600` in a `0700` dir, and the rollback journal (not WAL) keeps no extra side files.
- Additive only: nothing is ever planned for deletion.
- Symlinks are not followed, so a backup can't escape the chosen folder.

## Pattern to Copy
- `packages/cli/src/store/file-token-store.ts` (FN-08) for the owner-only file creation pattern.
- `packages/cli/src/commands/files.ts` (FN-11) for command structure.

## Verification
- Command: `pnpm check` (green, with the four new backup test files).
- Command: `node scripts/bench-backup-scan.ts` (prints the 20,000-file timings, with the no-change re-run under 30 s; recorded).
- Done when: the check is green and the benchmark is recorded. The delivery carries the check counts, the benchmark numbers and the verify-it report.

## Out of Scope
- Uploading, folder creation in Drive, sessions and Ctrl+C (FN-13), and `--verify` (FN-14).
- Reading the Windows hidden attribute.

## Checkpoint
- `Checkpoint: nao`

---

# Execution Record

- Branch `feat/FN-12-backup-scan`, executed 2026-11-22. `picomatch` 4.0.7 and `@types/picomatch` 4.0.3 (latest, checked with `npm view`) added to `@byos/cli`, exact.
- Order followed: manifest and plan first (the no-hash rule and the dry-run guarantee, the riskiest), then the scanner, then device, command and its tests, then the benchmark.
- **Benchmark** (`pnpm build && node scripts/bench-backup-scan.ts`, 2026-11-22, load average about 5): 20000 files, first plan 2.45 s (20000 hashes, 20000 to upload), no-change re-run **0.76 s** (0 hash calls, 0 to upload). The criterion was under 30 s.
- Mutation proofs (each restored, `cmp` equal): dropping the size and mtime shortcut fails three tests (the 1,000-file no-hash case among them); a dry run that refreshes the stored time fails the byte-identical table test; following symlinks fails the symlink test; a manifest created `0644` fails the permissions test; treating a row without an upload time as backed up fails its test.
- Deviations from the plan:
  - A dry run opens the manifest with `create: false`: when there is none, an in-memory one stands in and no file or folder is created, so a dry run on a new folder leaves the data directory untouched. An existing manifest is opened as usual (a pending schema migration would still apply).
  - A manifest row only counts as "unchanged" when it has an upload time. A row without one (a half state a later writer might leave) is planned again.
  - `scan(root, options, report)` takes the report object and fills it while the entries are consumed (skips, warnings, unreadable folders); `planBackup` merges it after the walk. Two extra skip reasons exist beside the plan's: `not-regular` (sockets, devices) and `duplicate` (two names equal after NFC in one folder: the second is skipped and warned, since both would share one manifest key).
  - The human output gained a "skipped (reason n, ...)" line, and `docs/cli-output.md` gained the `backup-dry-run-json` scenario and the `--json` shape. Remote-derived text is printed through `printable()`.
  - The benchmark imports the built `packages/cli/dist` (Node's type stripping can't resolve the `.js` specifiers of the TS sources), so it needs `pnpm build` first.
  - The device name defaults to `os.hostname()` read in the command; tests pass `--device`.
- **verify-it round 1: 96, no vetoes.** Fixed from its findings: the case-collision and NFC-duplicate tests are now `it.skipIf` with a real probe of the file system (APFS runs neither, so they run on the Linux CI) instead of passing without an assertion; the `PlanError` type moved to `scan.ts` (no type cycle with `plan.ts`); a comment on why the scanner normalizes one name itself instead of calling `normalizePath`; an existing manifest or its folder left with looser modes is tightened to `0600` and `0700` when opened (with a test).
- Not done, by choice: a dry run on an existing manifest still applies a pending schema migration (a write that never touches the upload columns).
- `BYOS_TEST_TIMEOUT=300000 pnpm check`: build, lint (0 warnings), typecheck and tests green.
