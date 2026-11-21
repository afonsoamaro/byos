# [FN-14] `byos backup --verify`

## Type
Functional

## Description
Lets the owner trust the backup: compares every manifest entry with Drive and reports what is missing or different, without repairing anything.

## User Flow
1. `byos backup C:\Users\me\Pictures --verify`
2. Prints counts of OK, missing in Drive, trashed in Drive, hash mismatch, and lists the problem files; exit non-zero if any problem.

## Requirements
- For each manifest row with a `drive_id`, `stat` by ID (batched with concurrency); compare `byosSha256` with the manifest hash.
- Trashed files count as a problem ("trashed in Drive").
- No uploads, no manifest changes except an optional `last_verified_at`.
- `--json` emits the report object.

## Scenarios
### Happy Path
- All files verified OK.
### Edge Cases
- File moved or renamed in Drive by the user: still OK (ID-based).
### Error Handling
- Deleted, trashed or altered remote files are each reported in their own category.

## Data Requirements
- Optional `last_verified_at` column (manifest migration).

## External Dependencies
- None new.

## Acceptance Criteria
- [ ] Each category (OK, missing, trashed, mismatch) tested.
- [ ] A remote rename/move is reported OK.
- [ ] No write to Drive (asserted on the fake).
- [ ] Exit code non-zero when any problem is found.

## Dependencies
- FN-13.

---

# Implementation Plan

## Prerequisites
- FN-13 done: `byos backup` with the manifest (`files` rows with `drive_id` and `sha256`), `context.ts` with the `createProvider` seam, `p-limit`, and the backup test helpers (`ResumableMemory`).
- Branch `feat/FN-14-backup-verify` from an up-to-date `main`. Node 26 in every shell, background ones included.

## Priorities
1. **Read-only:** verify never writes to Drive, and never changes the manifest.
2. Every problem category is distinct and actionable.
3. The acceptance criteria.

## Reusable Code Found
- `packages/cli/src/backup/manifest.ts`: the `files` rows. Add `allUploaded()` returning `{ relPath, sha256, driveId }[]`.
- `packages/cli/src/commands/backup.ts`: same flags (`--device`, `--remote-root`) to locate the manifest.
- `packages/drive/src/drive-provider.ts`: `#statById` already fetches `trashed`. It is exposed through a new Drive-specific method (below).
- `@byos/core/testing`: `MemoryProvider.snapshot()` reports `trashed`, which the CLI test double uses.

## Knowledge Registry
- **Absence tests** ("no write to Drive") need a control: the verify really called `stat` and `inspect`.
- **Background shells start on Node 24.**

## Architecture Decisions
- **Telling trashed from missing:** `StorageProvider.stat` hides trashed files (`undefined`), so the contract can't separate the two.
  - New Drive-specific `DriveProvider.inspect(id): Promise<{ stat: FileStat; trashed: boolean } | undefined>` (a 404 gives `undefined`) in `drive-provider.ts`, built on the same `files/<id>?fields=<FILE_FIELDS>` request.
  - The CLI uses `inspect` when the provider has it, and otherwise falls back to `stat`, where `undefined` counts as `missing`.
  - The CLI test double `ResumableMemory` (FN-13) gains `inspect` from the inner `MemoryProvider.snapshot()`.
- **`byos backup <folder> --verify [--device] [--remote-root] [--concurrency <n>] [--json]`:**
  - it opens the manifest read-only (`new DatabaseSync(path, { readOnly: true })`). A missing manifest gives `CliError('no backup found for this folder; run byos backup first', 2)`;
  - for each `allUploaded()` row it runs `inspect` or `stat` by id under `pLimit(concurrency)` (default 8, clamped to 1..16);
  - categories:
    - `ok`: found, not trashed, and `stat.sha256 === row.sha256`. A remote rename or move is still `ok`, because the check is by id;
    - `missing`: not found;
    - `trashed`: found with `trashed`;
    - `mismatch`: found but the `sha256` differs or is absent;
    - `error`: any other error, with `code` and `message`;
  - `--verify` and `--dry-run` together give exit 2;
  - the optional `last_verified_at` from the issue is **not** added: it would need a schema migration and a write, which contradicts read-only. Recorded here.
- **Output:**
  - human: counts per category, then one line per problem (`✗ missing  <relPath>`), PP-02 style;
  - `--json`: `{ ok: number, missing: string[], trashed: string[], mismatch: string[], errors: { relPath, code, message }[] }`, with the arrays holding relative paths;
  - the exit is 0 only when `missing`, `trashed`, `mismatch` and `errors` are all empty, else 1. An `AuthError` stops the run with exit 5.
- **`docs/cli-output.md`:** add a `backup-verify` scenario (human and JSON) to `scripts/cli-output-mock.ts`, and regenerate.

## Files to Create
| File | Purpose |
|------|---------|
| `packages/cli/src/backup/verify.ts` | `verifyBackup({ manifest, provider, concurrency })` returns the report |
| `packages/cli/test/backup/verify.test.ts` | Categories, rename and move OK, no writes, exit codes, `--json` |

## Files to Modify
| File | Changes |
|------|---------|
| `packages/drive/src/drive-provider.ts` | `inspect(id)` |
| `packages/drive/test/drive/read-operations.test.ts` | `inspect` cases: trashed `true`, live `false`, 404 `undefined` |
| `packages/cli/src/backup/manifest.ts` | `allUploaded()` and the read-only open |
| `packages/cli/src/commands/backup.ts` | `--verify` |
| `packages/cli/test/backup/resumable-memory.ts` | `inspect` via `snapshot()` |
| `scripts/cli-output-mock.ts` | `backup-verify` scenario |
| `docs/cli-output.md` | Regenerated |
| `issues/FN-14-backup-verify.md` | Execution Record |
| `issues/_index.md` | FN-14 `todo` → `planned` now; `done` only by verify-it |

## Data Requirements
- None (read-only).

## Testing Strategy
- `verify.test.ts`: back up a temp folder of 6 files with the FN-13 path into `ResumableMemory`, then alter the remote through the inner fake:
  - one untouched: `ok`;
  - one moved to another folder and renamed (`move`): `ok`;
  - one permanently deleted: `missing`;
  - one trashed: `trashed`;
  - one overwritten with other content (`put` `overwrite` with a different body): `mismatch`;
  - one with a `failNext('stat'/'inspect')` `ProviderError`: `errors`.
- Then:
  - exit 1 and every category correct;
  - `--json` has exactly that shape;
  - **no writes:** `calls.put`, `mkdir`, `move`, `copy` and `delete` are unchanged by the verify run. Control: the `inspect`/`stat` calls equal the number of rows;
  - the manifest file is byte-identical before and after (`readFile` compare);
  - all OK gives exit 0;
  - a missing manifest gives exit 2.
- In the drive tests: `inspect` on trashed, live and missing files.

## Implementation Order
1. **Riskiest first, telling trashed from missing.** Write `DriveProvider.inspect` with its drive tests, and `inspect` on the test double.
2. Write `verify.ts`, the command flag, the output, and `verify.test.ts`.
3. Update the mock scenario and regenerate the doc.
4. `pnpm format`, then `pnpm check`.

## Security Considerations
- Read-only. The verify path never calls a write method, as the test with control asserts.

## Pattern to Copy
- `packages/cli/src/backup/upload.ts` (FN-13) for `p-limit` use and the manifest access.

## Verification
- Command: `pnpm check` (green, including `verify.test.ts`, the drive `inspect` cases and the doc drift test).
- Done when: the check is green. The delivery carries the check counts and the verify-it report.

## Out of Scope
- Auto-repair of problems (no re-upload in v1), and `last_verified_at` (see above).

## Checkpoint
- `Checkpoint: nao`
