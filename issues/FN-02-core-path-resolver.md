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

---

# Implementation Plan

## Prerequisites
- FN-01 done: `StorageProvider`, `FileRef`, `FileStat`, `NotFoundError`, `ConflictError`, `ProviderError` and `MemoryProvider` (with `allowDuplicateNames`, `calls`, `failNext`) exist in `packages/core`.
- Branch `feat/FN-02-path-resolver` from an up-to-date `main`.
- Node 26 (`source ~/.nvm/nvm.sh && nvm use 26`).

## Reusable Code Found
- `packages/core/src/provider.ts`: `StorageProvider.list({ parent, pageSize, pageToken })` and `ListResult`, which back the default child lookup.
- `packages/core/src/errors.ts`: `NotFoundError`, `ConflictError`, `ProviderError`. No new error class is created.
- `packages/core/src/testing/memory-provider.ts`:
  - `allowDuplicateNames: true` produces Drive-like duplicates;
  - `calls.list` counts lookups;
  - `delete(..., { permanent: true })` plus re-creating a folder with the same name produces a stale cached id.
  - Its own `#segments` rule (drop empty segments, `.` or `..` raise `ProviderError`) is the same normalization this issue asks for, so the resolver matches it.
- `packages/core/test/memory-provider.test.ts`: the test style (a `provider()` factory, `bytes()` helper, one `describe` per behavior).
- `packages/core/src/index.ts`: where the new exports go.

## Knowledge Registry
- No entry covers path resolution or LRU caches. The plan follows the FN-01 conventions: `.js` suffix on relative imports, no Node built-ins in `src`, ES private fields (`#`) as in `MemoryProvider`.

## Architecture Decisions
- **The child lookup is injectable.**
  - The `StorageProvider` contract has no "find a child by name", and paging through `list` is expensive on a Drive folder holding thousands of photos.
  - `PathResolverOptions.findChildren?: (parentId: string, name: string) => Promise<readonly FileStat[]>`. The default pages through `provider.list({ parent: { id: parentId }, pageSize: 1000 })` and filters by name.
  - FN-04 passes a Drive query (`name = '<escaped>' and '<parent>' in parents and trashed = false`), and that is one request per segment.
  - "One lookup" in this issue means one `findChildren` call.
- **API:**
  - `new PathResolver(provider: StorageProvider, options: PathResolverOptions)`, where `PathResolverOptions` is `{ root: string; maxEntries?: number /* default 10_000 */; findChildren?: ... }`;
  - `resolve(path: string): Promise<string>` returns the id; an empty path (after normalization) returns `root` with no lookup;
  - `resolveParent(path: string): Promise<{ parentId: string; name: string }>` resolves every segment but the last, and returns the last segment as `name` without looking it up. That's what `put` and `mkdir` need. An empty path raises `ProviderError('the root has no parent')`;
  - `withPath<T>(path: string, fn: (id: string) => Promise<T>): Promise<T>` resolves `path` and runs `fn(id)`. If `fn` throws `NotFoundError` and the id came from the cache, it invalidates `path` and its descendants, resolves again without the cache, and runs `fn` once more. A second `NotFoundError` propagates. This is the "call that used a cached ID" mechanism the providers use;
  - `invalidate(path: string): void` drops the entry and every descendant (`key === p || key.startsWith(p + '/')`);
  - `clear(): void`.
- **Normalization (`normalizePath(path): string[]`, exported):**
  - split on `/` and drop empty segments, so leading, trailing and repeated slashes vanish;
  - a `.` or `..` segment raises `ProviderError` naming the path;
  - each segment is NFC-normalized (`segment.normalize('NFC')`), and names returned by `findChildren` are compared NFC-normalized too. A name typed on Windows (NFC) then matches one uploaded from macOS (often NFD);
  - no other character is special: `:`, `?`, `*`, spaces, accents and emoji are ordinary name characters, as in Drive;
  - backslash is not a separator. Converting Windows local paths is the CLI's job.
- **Walk:** for the normalized segments, find the longest cached prefix (`a/b/c` → try `a/b/c`, then `a/b`, then `a`) and start from its id, or from `root`. For each remaining segment, `findChildren(parentId, segment)`:
  - 0 matches raises `NotFoundError('no file at <path up to and including this segment>')`;
  - more than 1 match raises `ConflictError('more than one item named <segment> at <path up to it>')`;
  - an intermediate match that is not a folder raises `NotFoundError('no folder at <path up to it>')`;
  - otherwise it caches `prefix → id` and continues.
  - If `findChildren` throws `NotFoundError` while walking from a cached prefix (the cached parent is gone), invalidate that prefix and its descendants and restart the walk once from `root`, without the cache.
- **LRU:** a `Map<string, string>` keyed by the joined NFC path.
  - A hit deletes the key and sets it again to refresh recency.
  - An insert above `maxEntries` deletes the first key in iteration order.
  - O(n) descendant invalidation is fine at 10,000 entries.
- **No negative caching and no in-flight de-duplication.** Two concurrent resolves of the same uncached path both look it up. FN-05's `mkdir` serialization is a separate concern in the Drive provider.
- **Errors:** only the existing classes. A bad path is a `ProviderError`, the same choice `MemoryProvider` made for `.` and `..`.

## Files to Create
| File | Purpose |
|------|---------|
| `packages/core/src/path-resolver.ts` | `PathResolver`, `PathResolverOptions`, `normalizePath` |
| `packages/core/test/path-resolver.test.ts` | Contract tests against `MemoryProvider` |

### packages/core/src/path-resolver.ts
- Imports `ConflictError`, `NotFoundError` and `ProviderError` from `./errors.js`; types from `./file-stat.js` and `./provider.js`.
- Private fields: `#provider`, `#root`, `#maxEntries`, `#findChildren`, and `#cache = new Map<string, string>()`.
- Private methods: `#walk(segments, useCache)`, `#cacheGet(key)` (with refresh), `#cacheSet(key, id)` (with eviction), and `#defaultFindChildren(parentId, name)` (a `list` paging loop that follows `nextPageToken`).
- Doc comment on the class: the lookup is injectable and the default pages `list`; duplicates are never picked silently; names are compared NFC.
- Keep it under ~200 lines.

### packages/core/test/path-resolver.test.ts
- Copy the style of `packages/core/test/memory-provider.test.ts`. Build the trees with `mkdir({ parent: { path }, name, parents: true })` and `put`.
- A `lookups` counter comes from a `findChildren` wrapper around the default (an injected function that counts and delegates to `provider.list`). The "5 then 0" assertion reads that counter, plus `provider.calls.list`, for the default lookup.

## Files to Modify
| File | Changes |
|------|---------|
| `packages/core/src/index.ts` | `export { PathResolver, normalizePath } from './path-resolver.js';` and `export type { PathResolverOptions } from './path-resolver.js';` |
| `issues/FN-02-core-path-resolver.md` | Execution Record at the end |
| `issues/_index.md` | FN-02 `todo` → `planned` now; `done` only by verify-it |

Do not touch `MemoryProvider`, `docs/`, `packages/drive` or `packages/cli`.

## Data Requirements
- None.

## Testing Strategy
Cases in `path-resolver.test.ts`:
1. `resolve('BYOS Backup/pc/Pictures/2024/a.jpg')` returns the file's id. The first call makes 5 lookups (`provider.calls.list` grows by 5 with the default lookup); the second makes 0.
2. `resolveParent('a/b/c.txt')` returns `{ parentId: <id of a/b>, name: 'c.txt' }` even when `c.txt` doesn't exist. `resolveParent('')` raises `ProviderError`.
3. `''`, `'/'` and `'//'` resolve to `root` with 0 lookups. `'/a//b/'` resolves the same as `'a/b'` and shares its cache entry.
4. `'a/./b'` and `'a/../b'` raise `ProviderError`, before any lookup.
5. Names with spaces, accents (`Fotos de Família`), emoji (`🎉 party`), and `:` and `?` (`10:30 meeting?.txt`) resolve.
6. A name stored by the provider in NFD (`'Família'.normalize('NFD')`) resolves from the NFC path `Família`.
7. A missing segment raises `NotFoundError` whose message contains the path up to the missing segment (`a/missing`, not the full path).
8. An intermediate file (`a.txt/b`) raises `NotFoundError`.
9. Duplicates: with `new MemoryProvider({ allowDuplicateNames: true })` and two `dup.txt` under `dir`, `resolve('dir/dup.txt')` raises `ConflictError` with `dir/dup.txt` in the message.
10. Stale cache through `withPath`:
    - resolve `dir/a.txt`;
    - permanently delete `dir`, then re-create `dir/a.txt` (new ids);
    - `withPath('dir/a.txt', (id) => provider.get({ id }))` returns the new content;
    - `fn` ran twice, and the second time with the new id.
11. Stale cached parent during a walk: cache `dir`, permanently delete it, re-create `dir/b.txt`, and `resolve('dir/b.txt')` returns the new id (the walk restarts from `root` once).
12. A `NotFoundError` from `fn` when the id was *not* cached propagates after one call.
13. LRU: with `maxEntries: 2`, resolving `a`, `b`, then `c` evicts `a` (resolving `a` again costs a lookup) and keeps `c` (0 lookups). Re-reading `b` before adding `c` keeps `b`.
14. `invalidate('dir')` drops `dir` and `dir/x` but keeps `dirt`.
15. An injected `findChildren` is used instead of `list` (`provider.calls.list` stays 0).

## Implementation Order
1. **Riskiest first, the walk with an injected lookup and the stale-parent restart.** Write `path-resolver.ts` with `normalizePath`, the walk, the cache and `withPath`, then write cases 1, 10 and 11 and run them (`pnpm --filter @byos/core exec vitest run test/path-resolver.test.ts`) before the rest. The restart rules are where an infinite loop or a silent wrong id would hide.
2. Write the remaining cases.
3. Add the `index.ts` exports.
4. `pnpm format`, then `pnpm check`.

## Security Considerations
- None specific. The resolver handles names, not tokens, and its error messages contain only the user-supplied path segments.

## Pattern to Copy
- `packages/core/src/testing/memory-provider.ts` for class layout (`#` private fields, a doc comment on the class) and the `.`/`..` rule.
- `packages/core/test/memory-provider.test.ts` for the test layout.

## Verification
- Command: `pnpm check` (green, with the new path-resolver tests in the core package count).
- Command: `grep -rn "node:" packages/core/src` (no output).

## Out of Scope
- The Drive `findChildren` query and its quote escaping (FN-04).
- `mkdir -p` creation and its serialization (FN-05). The resolver only resolves and never creates.
- Converting Windows local paths to remote paths (the CLI, FN-11 and FN-12).
- In-flight de-duplication, negative caching, persistence of the cache.
- Changes to `MemoryProvider`.

## Checkpoint
- `Checkpoint: nao`

---

# Execution Record

- Branch `feat/FN-02-path-resolver`, executed 2026-11-20.
- Implemented as planned: `PathResolver` (`resolve`, `resolveParent`, `withPath`, `invalidate`, `clear`), `normalizePath`, an injectable `findChildren` that defaults to paging `list`, an LRU cache, and NFC name comparison.
- Deviations:
  - A walk that starts from a cached prefix restarts once from the root on any `NotFoundError`, not only when `findChildren` throws: a cached folder that was moved (id still valid, contents different) then also recovers.
  - The test file has 18 cases (the plan's 15, with case 5 run for three names), plus a check of `normalizePath` itself.
- Mutation check: removing the restart in `#locate` failed exactly the two stale-cache tests (`withPath` retry, cached parent gone). Restored.
- `pnpm check`: build, lint (ESLint 0 warnings, Prettier clean), typecheck and tests green: 95 passed (66 in core, 2 in drive, 2 in cli, 25 in the root suite). `grep -rn "node:" packages/core/src` prints nothing.
- After the independent verification (96, no vetoes):
  - Added a test that finds a child on the second `list` page (1,001 children).
  - The stale-parent test now asserts exactly 3 lookups (one failed under the stale id, then one walk from the root), which proves the restart happens once.
  - A comment explains why `#walk` filters by NFC name again even after the default lookup filtered.
- Final `pnpm check` after the additions: green, 96 tests (67 in core, 2 in drive, 2 in cli, 25 in the root suite).
