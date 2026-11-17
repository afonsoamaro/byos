# [FN-02] Core path resolver

## Type
Functional

## Description
Consumers keep IDs, but humans and the CLI speak paths. `PathResolver` turns `"BYOS Backup/pc/Pictures/2024/a.jpg"` into a file ID by walking folder names from a root, using only `list`/`stat` on any `StorageProvider`, with a cache.

## User Flow
1. A provider receives `{ path }`, asks the resolver for the ID, and continues with ID-based calls.

## Requirements
- `PathResolver(provider, { root })` with `resolve(path): Promise<string>` and `resolveParent(path): Promise<{ parentId, name }>`.
- Paths are POSIX (`/`), relative to the configured root; leading/trailing slashes and repeated slashes are normalized; `.` and `..` segments are rejected.
- In-memory LRU cache of path → ID, bounded (default 10,000 entries).
- On `NotFoundError` from a call that used a cached ID, the entry and its descendants are invalidated and the path is resolved once more.
- Drive allows two items with the same name in one folder: when a segment matches more than one item, the resolver raises `ConflictError` naming the path; it never picks one silently.
- Provider-agnostic: lives in `core`, tested against the FN-01 in-memory fake.

## Scenarios
### Happy Path
- Resolving a 5-level path does 5 lookups the first time and 0 the second.
### Edge Cases
- Names containing spaces, Unicode (accents, emoji), and characters that are illegal on Windows but legal in Drive (`:`, `?`).
- Empty path resolves to the root.
### Error Handling
- Missing segment raises `NotFoundError` with the path up to the missing segment.
- Duplicate names raise `ConflictError`.

## Data Requirements
- None.

## External Dependencies
- None.

## Acceptance Criteria
- [ ] `resolve` and `resolveParent` work over the fake provider for nested paths.
- [ ] Cache hit avoids lookups (asserted by counting fake calls).
- [ ] Stale cache entry is invalidated and re-resolved after `NotFoundError`.
- [ ] Duplicate-name segment raises `ConflictError`.
- [ ] `..` and `.` are rejected; slashes are normalized.

## Dependencies
- FN-01.
