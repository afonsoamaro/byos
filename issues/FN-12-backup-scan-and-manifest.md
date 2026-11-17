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
