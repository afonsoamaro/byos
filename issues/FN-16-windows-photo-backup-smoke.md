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
