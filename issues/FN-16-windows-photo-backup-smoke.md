# [FN-16] Windows photo backup smoke (first consumer)

## Type
Functional (real-use validation)

## Description
The discovery's condition 3: BYOS earns its existence by storing something real. The owner runs `byos backup` on their real Windows photo folder against their own Drive, and this issue records what actually happened. It is also the speed gate in SPECS open question 6: if this lands quickly, the photo backup is the first consumer; if it stalls, the bill tracker integration (FN-17) goes first.

## User Flow
1. On the Windows machine: install Node LTS, install the CLI from the repo (`pnpm` build + global link, or a packed tarball).
2. `byos doctor`, fix what it says; `byos auth`.
3. `byos backup <Pictures folder> --dry-run`, then a real run.
4. Interrupt one run with Ctrl+C during a large video; re-run.
5. `byos backup ... --verify`.
6. Open Drive in the browser and check a few photos open and the folder mirrors the local one.

## Requirements
- Steps above performed by the owner; agent prepares a checklist and reads back the outputs.
- Measure and record: file count, total size, first-run duration, no-change re-run duration, number of retries/rate limits, any failure.
- Every rough edge found becomes its own issue, linked here, rather than being fixed inside this one.

## Scenarios
### Happy Path
- Full backup completes; verify reports all OK; re-run uploads nothing.
### Edge Cases
- Windows-specific: OneDrive-redirected Pictures folder, files with names illegal elsewhere, very long paths.
### Error Handling
- Any crash or data issue blocks closing this issue until triaged.

## Data Requirements
- None.

## External Dependencies
- Owner's Windows machine, Google account, Google Cloud project (published to production, not Testing).

## Acceptance Criteria
- [ ] Real backup of the owner's photo folder completed, with the measurements recorded here.
- [ ] Interrupt-and-resume worked on a real large video.
- [ ] `--verify` reports zero problems.
- [ ] Follow-up issues created for every problem found.
- [ ] Speed-gate verdict recorded (photo backup is or isn't the first consumer).

## Dependencies
- FN-10, FN-13, FN-14.

---

# Implementation Plan

## Prerequisites
- FN-10, FN-13 and FN-14 done: `byos doctor`, `byos backup` (upload, resume, Ctrl+C) and `byos backup --verify`.
- FN-09's manual run is recorded (real Google sign-in works with the owner's Desktop client).
- The owner's Windows machine has Node 26, the version in `.nvmrc` and `devEngines` (not "LTS" as the issue text says), and pnpm 12 (Corepack or the standalone installer).
- Branch `chore/FN-16-windows-smoke` from an up-to-date `main`, for the checklist and the recorded results only.

## Priorities
1. **No data loss on the owner's machine or Drive:** the backup is additive, and nothing local is ever modified.
2. Honest measurements, with every rough edge turned into its own issue instead of being fixed here.
3. The speed-gate verdict (SPECS Open Question 6).

## Reusable Code Found
- The whole CLI. This issue adds no product code.
- `docs/cli-output.md`: what each command should print, to compare against what the run shows.
- `packages/cli/src/backup/*`: the manifest location (`%LOCALAPPDATA%\byos\manifests`), useful for the "no-change re-run" timing and for diagnosing.

## Knowledge Registry
- **Windows:** the token store relies on the per-user ACL of `%APPDATA%` (FN-08 decision). Note in the results whether `icacls %APPDATA%\byos` shows only the owner (with admins and SYSTEM inherited).

## Architecture Decisions
- **Install path:** a packed tarball, closest to the npm install in FN-19.
  - On the dev machine: `pnpm --filter @byos/core pack`, the same for `@byos/drive` and `@byos/cli`, giving three `.tgz` files.
  - On Windows: `npm i -g <core.tgz> <drive.tgz> <cli.tgz>`.
  - The fallback (`pnpm build` and a global link from a clone) is recorded if the tarball install fails, and that failure becomes a follow-up issue.
- **Checklist doc `docs/smoke/windows-photo-backup.md`,** written by the agent before the run, with copy-paste commands for each step of the User Flow and a results table to fill in:
  - Windows version, and Node and pnpm versions;
  - Pictures path, including whether it is **OneDrive-redirected** (`%USERPROFILE%\OneDrive\Pictures`), and whether files are "online-only" placeholders, which would make reads trigger downloads; note it;
  - `byos doctor` output (pass, warn, fail);
  - the dry run: files found, to upload, total size, largest file, and the scan duration;
  - the first real run: duration, uploaded, failed, retries (from progress or the summary), and any quota or rate-limit messages;
  - **interrupt:** Ctrl+C during a large video (pick one over 500 MB). Record the offset in the manifest: `sqlite3` isn't required, the next run's resume is the evidence, and resume time is noted;
  - the re-run after completion: duration (no-change) and files uploaded (must be 0);
  - `--verify`: the counts per category (must be all OK);
  - the browser check: 3 photos and 1 video open in Drive, and the folder tree mirrors the local one under `BYOS Backup/<device>/Pictures`;
  - Windows-specific notes: very long paths, names with characters illegal on other OSes, and anything skipped (symlinks, system files).
- **Agent role during the run:** read back each output the owner pastes, compare it with `docs/cli-output.md` and the issue's expectations, and note deviations. **No fixes inside this issue:** each problem becomes a new issue file `issues/FN-2x-<slug>.md` (next free number), linked from the results, and added to `_index.md` as `todo`.
- **Speed-gate verdict:**
  - when the full backup, the resume and the verify all succeed within the session(s) the owner is willing to spend, the photo backup is the first consumer;
  - otherwise FN-17 (bill tracker) goes first;
  - the verdict, with its one-line reason, goes into this issue and `SPECS.md` Open Question 6.

## Files to Create
| File | Purpose |
|------|---------|
| `docs/smoke/windows-photo-backup.md` | The owner's checklist and results template |
| `issues/FN-2x-*.md` | One per problem found (as many as needed) |

## Files to Modify
| File | Changes |
|------|---------|
| `issues/FN-16-windows-photo-backup-smoke.md` | Filled results table, links to follow-ups, speed-gate verdict |
| `SPECS.md` | Open Question 6 resolved with the verdict |
| `issues/_index.md` | FN-16 `todo` → `planned` now; follow-up issues added; `done` only by verify-it |

## Data Requirements
- None. Real data stays on the owner's machine and Drive. The results record counts, sizes and durations, never file names that reveal personal content: describe them generically ("a 1.2 GB .mp4").

## Testing Strategy
- None automated: the run is the test. `pnpm check` stays green for the doc and issue changes.

## Implementation Order
1. Write the checklist doc and commit it to the branch (the owner reads it on GitHub or locally).
2. Make the tarballs (`pnpm -r pack` into a temp dir) and hand them to the owner. Record their file names and versions.
3. **Owner run**, step by step, with outputs pasted back.
4. Record the results, create follow-up issues, write the verdict in the issue and SPECS, then `pnpm check`.

## Security Considerations
- The results contain no personal file names, paths beyond the generic `Pictures` location, tokens or session URIs.
- The owner's real client JSON stays outside the repo.

## Pattern to Copy
- `docs/spikes/cross-client-visibility-checklist.md` (FN-15) for the checklist format.

## Verification
- Manual: the owner's run recorded in the results table, with every acceptance item ticked or with a linked follow-up issue explaining why not.
- Command: `pnpm check` (green).
- Done when: the backup, the interrupt-and-resume and `--verify` are recorded, follow-ups are filed, the speed-gate verdict is written in the issue and SPECS, and the check is green. The delivery carries the filled table.

## Out of Scope
- Fixing problems found (each gets its own issue).
- macOS or Linux runs.
- Scheduling the backup (Task Scheduler) is a candidate follow-up, not part of this smoke.

## Checkpoint
- `Checkpoint: nao`
