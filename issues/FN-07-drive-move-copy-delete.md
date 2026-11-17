# [FN-07] Drive provider: move, copy and delete

## Type
Functional

## Description
The remaining operations of the full set. v1 has no first consumer for them (owner decision, recorded in SPECS), so this issue keeps them minimal and fully tested against the contract instead of inventing options.

## User Flow
1. `move({ source, targetParent, newName? })`, `copy({ source, targetParent, newName? })`, `delete({ ref, permanent? })`.

## Requirements
- `move`: `files.update` with `addParents`/`removeParents` and optional rename; same `ConflictError` rule as `put` when the target name exists.
- `copy`: `files.copy`; folders are not copyable in Drive, so copying a folder raises a clear `ProviderError` (recursive copy is out of v1).
- `copy` keeps `appProperties.byosSha256`.
- `delete`: trash by default (`trashed: true`); `permanent: true` uses `files.delete`. Deleting a folder trashes the folder (Drive trashes children with it).
- With `drive.file`, a file not created by the app raises `PermissionError`, tested.

## Scenarios
### Happy Path
- Move a file into another folder with a new name; copy a file; trash a file.
### Edge Cases
- Move onto its own parent with the same name is a no-op returning the same `FileStat`.
### Error Handling
- Not found → `NotFoundError`; target exists → `ConflictError`; folder copy → `ProviderError`.

## Data Requirements
- None.

## External Dependencies
- Drive API v3 `files.update`, `files.copy`, `files.delete`.

## Acceptance Criteria
- [ ] Each operation has a happy-path test and its error-mapping tests.
- [ ] `delete` defaults to trash; `permanent` is explicit.
- [ ] `copy` preserves `byosSha256`.
- [ ] The in-memory fake (FN-01) and `DriveProvider` pass the same shared contract test suite for all eight operations.

## Dependencies
- FN-05.
