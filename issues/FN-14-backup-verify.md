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
