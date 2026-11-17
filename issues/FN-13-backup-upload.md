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
