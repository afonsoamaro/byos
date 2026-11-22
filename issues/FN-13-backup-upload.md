# [FN-13] `byos backup`: upload, resume and progress

## Type
Functional

## Description
Second half of backup: execute the plan from FN-12 with bounded concurrency, resume interrupted resumable uploads from the manifest, and report progress and a final summary.

## User Flow
1. `byos backup C:\Users\me\Pictures`
2. Remote folders are created as needed, files upload four at a time, progress shows live (PP-02), the summary prints at the end.
3. User presses Ctrl+C during a 3 GB video. The next run resumes that video from its confirmed offset.

## Requirements
- Remote folder IDs cached in the manifest `folders` table; `mkdir -p` only for folders not cached; a cached folder that returns `NotFoundError` (user deleted it in Drive) is recreated and the cache fixed.
- Uploads with `p-limit`, `--concurrency` default 4, max 16.
- New file → `put` with `sha256`; changed file with a stored `drive_id` → `put` `overwrite` as a new revision of that ID. **Never deletes and never overwrites a file the manifest didn't create.**
- Resumable sessions persisted to `sessions` via `onResumableSession`; at start, sessions for files still unchanged are resumed with `resumeUpload` from the confirmed offset; expired sessions restart from zero.
- A file is written to `files` only after Drive confirms the upload and the returned `sha256` matches the local hash.
- Ctrl+C: stop starting new uploads, let in-flight chunks reach a confirmed offset or abort within 5 s, write state, print the "next run resumes" message, exit 130.
- `RateLimitError` handled by provider retry; `QuotaExceededError` stops the whole run immediately with the PP-02 message; other per-file errors are recorded and the run continues.
- Non-TTY / `--json`: no redraw; `--json` emits a final summary object only.

## Scenarios
### Happy Path
- 500 files of mixed sizes, including two above 5 MiB, upload against the fake provider; manifest complete; second run uploads nothing.
### Edge Cases
- Kill mid-resumable upload (simulated) then rerun: resumes, no duplicate file in Drive.
- Folder deleted in Drive between runs: recreated, upload proceeds.
### Error Handling
- Quota exceeded stops the run with exit 6; already-uploaded files remain recorded.
- Hash mismatch after upload: file reported failed, not recorded.

## Data Requirements
- Manifest tables from FN-12.

## External Dependencies
- p-limit.

## Acceptance Criteria
- [ ] Full backup against the fake provider, then a no-op second run.
- [ ] Interrupted resumable upload resumes from the stored offset without duplicates.
- [ ] Ctrl+C handling leaves a consistent manifest (tested by aborting mid-run and re-running).
- [ ] Changed local file becomes a new revision of the same Drive ID.
- [ ] Quota stop and per-file failure paths tested with correct exit codes.
- [ ] No code path calls `delete` (asserted by the fake provider counting calls).

## Dependencies
- FN-06, FN-12.

---

# Implementation Plan

## Prerequisites
- FN-06 and FN-12 done:
  - `DriveProvider.put` (simple and resumable, `onResumableSession`, which needs `size` and `sha256` over 5 MiB);
  - `DriveProvider.resumeUpload({ session, name, sha256, openAt })` (`UPLOAD_SESSION_EXPIRED` on expiry);
  - `packages/cli/src/backup/{scan,manifest,plan,device}.ts` and `commands/backup.ts`, with only the dry run working;
  - the manifest API: `folderId` / `setFolderId`, `session` / `setSession` / `clearSession`, `recordUpload`, and the `sessions` table.
- Add `p-limit` `7.3.3` (SPECS pin, still the latest, checked 2026-11-21) to `packages/cli` `dependencies`, exact: `pnpm --filter @byos/cli add p-limit@7.3.3 --save-exact`. Stage `pnpm-lock.yaml`.
- Branch `feat/FN-13-backup-upload` from an up-to-date `main`. Node 26 in every shell, background ones included.

## Priorities
1. **Never delete, and never overwrite a file the manifest didn't create.** A file is recorded only after Drive confirms it and the hashes match.
2. An interrupted run resumes without duplicates, and the manifest is always consistent after Ctrl+C or a quota stop.
3. The acceptance criteria.
4. Throughput (bounded concurrency).

## Reusable Code Found
- `packages/cli/src/backup/plan.ts`: `planBackup` returns the `toUpload` items, carrying `driveId` for changed files.
- `packages/cli/src/backup/manifest.ts`: all persistence. It is synchronous `DatabaseSync`, so every write is complete when the call returns.
- `packages/cli/src/local.ts`: the streaming SHA-256 and local path helpers.
- `packages/cli/src/output.ts`: human versus `--json`. The progress line rules (redraw on a TTY, a line every 10 % otherwise) are ported from `scripts/cli-output-mock.ts` (`runProgress`).
- `scripts/cli-output-mock.ts`: the `backup` and `backup-interrupted` scenarios give the exact summary, quota-stop and interrupted texts.
- `@byos/core/testing`: `MemoryProvider` (with `calls`, `failNext` and `snapshot`).

## Knowledge Registry
- **Injected failures** must be proved by mutation, and only count if the failure reaches what the test observes. A retried error is swallowed.
- **Spawning per test** times out under load: test in-process through `main()`.
- **Background shells start on Node 24.**

## Architecture Decisions
- **Executor (`packages/cli/src/backup/upload.ts`):** `runBackup({ plan, manifest, provider, layout, concurrency, out, signal, hash })` returns `{ uploaded, failed, remaining, stoppedBy?: 'quota' | 'interrupt' }`.
  - `layout`: the remote base is `<remoteRoot>/<device>/<folderName>`, and each file's parent is the base plus its `relPath` directory segments.
  - **Folders** go through `ensureFolder(relDir)`:
    - the manifest cache (`folderId`) is used first;
    - otherwise it walks the segments from the base with `provider.mkdir({ parent: { id }, name })` (idempotent) and `setFolderId` for each;
    - the base itself is cached under `relDir ''`;
    - concurrent callers share one promise per `relDir` (an in-flight map).
  - **A stale folder cache:** if an upload fails with `NotFoundError` on a cached parent, it clears that folder and its descendants (`folders` rows by prefix), re-ensures, and retries the file once.
  - **Concurrency:** `pLimit(concurrency)`. `--concurrency` defaults to 4, clamped to 1..16.
- **Per file:**
  1. **Resume first:** if `manifest.session(relPath)` exists with the same `size` and `sha256` as the plan item, and the provider has `resumeUpload`, call `resumeUpload({ session: { uri, offset, size }, name, sha256, openAt: (offset) => Readable.toWeb(fs.createReadStream(absPath, { start: offset })), onResumableSession: save })`.
     - `UPLOAD_SESSION_EXPIRED`: `clearSession` and fall through to a fresh upload.
     - A session for a different `size` or `sha256`: `clearSession` and upload fresh.
  2. **Fresh upload:** `provider.put({ parent: { id: parentId }, name, body: Readable.toWeb(createReadStream(absPath)), size, sha256, overwrite: driveId !== undefined, onResumableSession: (s) => manifest.setSession(relPath, s) })`.
  3. **Never overwrite what the manifest didn't create:**
     - **New file (no `driveId`):** `overwrite` is false. A `ConflictError` means a same-name file is already there, for example when the manifest was lost. Then `stat` it: the same `sha256` means adopt it (record it, count it as uploaded); otherwise a per-file failure "a different file with this name already exists in Drive; not overwritten".
     - **Changed file with a stored `driveId`:** `overwrite` is true. If the returned id isn't the stored `driveId`, that is a per-file failure "the Drive file for this path changed; not recorded", and it is not recorded.
  4. **Record only on confirmation:** when the result's `sha256` equals the local `sha256`, run `recordUpload(relPath, { size, mtimeMs, sha256, driveId: result.id })` and `clearSession`. A mismatch is a per-file failure, not recorded.
- **Errors:**
  - `QuotaExceededError`: stop the whole run. Clear the queue (`limit.clearQueue()`), let the in-flight uploads settle (they fail or finish), print the PP-02 quota message, and exit 6;
  - `AuthError`: the same stop, exit 5;
  - any other error: a per-file failure, the run continues, and the exit is 1 at the end if any failed;
  - `RateLimitError` is already retried inside the provider.
- **Ctrl+C:**
  - `CliIO` gains `onInterrupt(handler): () => void`. `realIO` binds it to `process.once('SIGINT')`, and tests call the handler directly;
  - on interrupt: stop scheduling (`clearQueue`), wait for the in-flight uploads **up to 5 s** (`Promise.race`), print the PP-02 interrupted text ("N files uploaded and recorded; M partial uploads saved. Run the same command to resume."), and return exit 130;
  - sessions were persisted by `onResumableSession` after every confirmed chunk, so they are already in the manifest;
  - `bin.ts` calls `process.exit(code)` when `main` returns 130, because uploads cut off mid-request would otherwise keep the event loop alive;
  - the provider has no abort signal, so an in-flight chunk isn't cancelled mid-request. Drive discards an unconfirmed partial chunk, and the next run resumes from the confirmed offset. Recorded here.
- **Progress:**
  - **TTY:** a redrawn line `[ done/total ]  bytes / total  rate  current-file`, updated from `onUploadProgress` events (wired in `context.ts` when the provider is a `DriveProvider`) and from per-file completion;
  - **not a TTY:** a plain line at every 10 %;
  - **`--json`:** no progress, only the final summary `{ uploaded, skipped, failed, remaining, stoppedBy?, failures: [{ relPath, code, message }] }`.
- **Command:** `backup` without `--dry-run` runs scan, plan and `runBackup`; this replaces FN-12's placeholder error. `--concurrency <n>` is a new option. The exit codes are 0, 1 (any failure), 5, 6 and 130, per PP-02.
- **Test double with resumable behavior (`packages/cli/test/backup/resumable-memory.ts`):** `ResumableMemory` wraps `MemoryProvider`.
  - For a `put` over a threshold (for example 1 MiB in tests), it emits `onResumableSession({ uri: 'mem://s<n>', offset, size })` per 256 KiB "chunk", and it can be told to throw after N chunks (to simulate a kill).
  - Its `resumeUpload` continues from the stored offset, reads `openAt(offset)` and completes the put into the inner `MemoryProvider`.
  - It counts `calls`, so the tests can assert "no duplicate" and "no delete".
  - It lives in CLI tests only, because the CLI must not depend on the drive package's test fake.

## Files to Create
| File | Purpose |
|------|---------|
| `packages/cli/src/backup/upload.ts` | `runBackup`: folders, resume, upload, record, stop rules |
| `packages/cli/src/backup/progress.ts` | Progress line (TTY redraw, non-TTY deciles), ported from the PP-02 mock |
| `packages/cli/test/backup/resumable-memory.ts` | Resumable-capable test double over `MemoryProvider` |
| `packages/cli/test/backup/upload.test.ts` | Executor behavior |
| `packages/cli/test/backup/backup-command.test.ts` | End-to-end through `main()`: full run, no-op re-run, summary and `--json` |

## Files to Modify
| File | Changes |
|------|---------|
| `packages/cli/src/commands/backup.ts` | Run uploads when not a dry run; `--concurrency` |
| `packages/cli/src/main.ts` | `CliIO.onInterrupt`; `realIO` binds SIGINT |
| `packages/cli/src/bin.ts` | `process.exit` on 130 |
| `packages/cli/src/context.ts` | Wire `events.onUploadProgress` to the progress reporter for `DriveProvider` |
| `packages/cli/package.json` | `p-limit` |
| `pnpm-lock.yaml` | Install |
| `issues/FN-13-backup-upload.md` | Execution Record |
| `issues/_index.md` | FN-13 `todo` → `planned` now; `done` only by verify-it |

## Data Requirements
- It uses the FN-12 manifest tables. `sessions` rows are written by `onResumableSession` and cleared on completion or expiry.

## Testing Strategy
- Temp source folders, temp `BYOS_DATA_DIR`, `ResumableMemory` or `MemoryProvider` through `createProvider`, and `retry` set to zero delay where relevant.
- `upload.test.ts`:
  1. **500 files of mixed sizes** (two above the 1 MiB resumable threshold): all are uploaded and recorded, the remote tree mirrors `<root>/<device>/<folder>/...`, and a second run uploads nothing (0 `put` calls).
  2. **Kill and resume:** the double throws after 2 chunks of a large file. The run ends with that file failed and its session stored. The rerun calls `resumeUpload` from the stored offset (asserted), there is exactly one file in the remote with that name, and its bytes are intact.
  3. An expired session on resume (the double throws `UPLOAD_SESSION_EXPIRED`): the session is cleared, a fresh upload follows, and there is one file.
  4. A folder deleted remotely between runs (`delete` with `permanent` on the cached folder in the inner fake): it is recreated, the upload proceeds, and the cache is fixed.
  5. A changed local file with a stored `driveId` becomes a new revision of **the same id**.
  6. **Never overwrite foreign files:**
     - the manifest is lost and the remote has a same-name file with the same hash: adopted, with no upload;
     - with a different hash: a per-file failure, and the remote is unchanged.
  7. A hash mismatch after upload (the double returns another `sha256`): a per-file failure, not recorded.
  8. **Quota:** `failNext('put', QuotaExceededError)` mid-run stops scheduling, the already uploaded files stay recorded, and the exit is 6.
  9. **Interrupt:** call the `onInterrupt` handler mid-run. Scheduling stops, the run returns 130 within the 5 s bound (fake timers or a short real wait), the manifest is consistent (recorded rows match the remote), and a rerun completes the rest without duplicates.
  10. **No `delete` anywhere:** `calls.delete === 0` across tests 1 to 9.
  11. A concurrency of 16 is honored, and 20 is clamped (count of simultaneous in-flight puts with a gated double).
- `backup-command.test.ts`:
  - the human summary matches the PP-02 `backup` scenario shape;
  - `--json` prints only the summary object;
  - the exit codes are 0, 1, 6 and 130.
- **Mutation proofs**, recorded in the Execution Record:
  - record before checking `sha256`: test 7 must fail;
  - skip the resume path: test 2 must fail (a duplicate or a restart from zero);
  - pass `overwrite: true` for new files: test 6 must fail.

## Implementation Order
1. **Riskiest first, the record rule and the never-overwrite rule.** Write `upload.ts` with fresh uploads, the folder cache and the conservative recording, then tests 1, 5, 6, 7 and 10 with `MemoryProvider`.
2. Write `ResumableMemory`, the resume path, expiry, and tests 2 and 3.
3. Write the stale folder cache (test 4), the stop rules (quota and auth), the interrupt, and tests 8, 9 and 11.
4. Write the progress output and the command wiring, then `backup-command.test.ts`.
5. Run the mutations.
6. `pnpm format`, then `pnpm check`.

## Security Considerations
- Session URIs (bearer-like) live only in the 0600 manifest and in memory, and they are never printed. The progress and summary print relative paths only.
- No code path deletes remote files, which test 10 asserts. Overwrite happens only for the manifest's own `driveId`, which the id check enforces.

## Pattern to Copy
- `packages/cli/src/backup/plan.ts` (FN-12) for module style and injected dependencies.
- `scripts/cli-output-mock.ts` `runProgress` for the progress rules.
- `packages/drive/src/api/creates.ts` `FolderMaker` for the shared in-flight map pattern.

## Verification
- Command: `pnpm check` (green, with the two new backup test files).
- Done when: the check is green and the three mutation proofs fail as expected and are restored. The delivery carries the check counts, the mutation results and the verify-it report.

## Out of Scope
- `--verify` (FN-14), the real Windows run (FN-16), and cancelling in-flight HTTP requests (no abort support in the provider in v1).

## Checkpoint
- `Checkpoint: nao`

---

# Execution Record

- Branch `feat/FN-13-backup-upload`, executed 2026-11-22. `p-limit` 7.3.3 (the SPECS pin, still the latest) added to `@byos/cli`, exact.
- Order followed: the executor with the record rule and the never-overwrite rule first (tests for full runs, revisions, foreign files, hash mismatch), then the resumable test double and the resume path, then the folder cache, the stop rules, interrupt and concurrency, then progress and the command.
- Mutation proofs (each restored, `diff` equal): dropping the content hash check fails the hash-mismatch test (the file would have been recorded); skipping the resume path fails the kill-and-resume test; passing `overwrite: true` for a new file fails the foreign-file test (the other user's bytes would be replaced).
- Deviations from the plan:
  - `CliIO.onInterrupt` is declared in `io.ts` (where `CliIO` lives) rather than `main.ts`, and `createProvider` now receives the provider events so progress can follow the real `DriveProvider`.
  - The queue is not cleared with `limit.clearQueue()`: that leaves the pending promises unresolved forever, so the run could never finish waiting. Each queued file checks a stop flag when its turn comes and returns without starting.
  - `Manifest.clearFolders(relDir)` was added (a stale folder cache drops the folder and everything under it).
  - Before overwriting a changed file the executor looks up the stored Drive id: gone (trashed or deleted) means it uploads as a new file; moved or renamed means a per-file failure. The returned id is still compared after the upload. The plan only had the after-the-fact check, which comes too late to protect a file.
  - A file whose size or modification time changed between the plan and its turn is a per-file failure (`CHANGED`), so the recorded hash always describes the bytes that were sent.
  - A same-name file that already exists in Drive with the same content is adopted (recorded, counted as uploaded); a different one is a `CONFLICT` failure. Failures carry `CONFLICT`, `REMOTE_CHANGED`, `HASH_MISMATCH`, `CHANGED`, `LOCAL_IO` or the provider's own code.
  - `docs/cli-output.md` (generated from the PP-02 mock) gained the real-run `--json` shape and the concurrency and no-delete rules.
  - `test/backup/plan.test.ts` (FN-12) now gives its 1,000-file test the same `BYOS_TEST_TIMEOUT` room as the other heavy tests; under load it missed the 5 s default by 0.7 s. `test/helpers.ts` gained `interrupt()`, and the placeholder test for a run without `--dry-run` became "no sign-in stops before scanning (exit 5)".
- Known limits, by design: a request in flight is not cancelled (the provider has no abort in v1); Drive drops the unconfirmed part of a chunk and the next run resumes from the confirmed offset. A file removed from Drive by hand is not noticed until `--verify` (FN-14). The progress bytes come from the provider's upload events, keyed by file name, so two same-named files uploading together can blur the byte count (the file count stays exact).
- `BYOS_TEST_TIMEOUT=300000 pnpm check` (machine under load, average about 38): build, lint (0 warnings), prettier and typecheck green; tests 83 core, 162 drive, 228 cli (2 skipped on this file system), 30 root.
- **verify-it round 1: 95, no vetoes.** Fixed from its findings: tests for the auth stop and for Ctrl+C during a resumable upload (the saved session counts as a partial upload). Left open, low: `runBackup` is long and `upload.ts` also holds the folder cache and error description, `commands/backup.ts` is about 300 lines with a nine-parameter `runUpload`.
