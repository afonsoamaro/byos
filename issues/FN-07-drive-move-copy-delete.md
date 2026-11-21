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

---

# Implementation Plan

## Prerequisites
- FN-05 and FN-06 done:
  - `DriveProvider` with `list`, `stat`, `get`, `put` and `mkdir`; the stubs `move`, `copy` and `delete` throw "not implemented";
  - `api/creates.ts` (`createWithReconcile`), `api/client.ts` (`json`, `jsonOnce`, `rawOnce`, `DriveRequestInit` with `PATCH`), `api/files.ts`, `api/errors.ts` (403 `appNotAuthorizedToFile` gives `PermissionError`);
  - the Drive test fake and `test/drive/setup.ts`.
- The User Flow line above is from the break. The real signatures are the FN-01 contract: `move(ref, { parent?, name? })`, `copy(ref, { parent, name? })`, `delete(ref, { permanent? })`.
- Branch `feat/FN-07-drive-move-copy-delete` from an up-to-date `main`. Node 26 in every shell, background ones included.

## Priorities
1. Never lose data by accident: `delete` trashes unless `permanent` is explicit, a name clash never replaces a file, and the root is never deleted.
2. The fake and Drive behave the same, enforced by one shared contract suite.
3. The acceptance criteria.

## Reusable Code Found
- `packages/core/src/testing/memory-provider.ts` holds the reference semantics:
  - `move` refuses a name clash and moves into its own subtree, and keeps the id;
  - `copy` refuses folders, gives a new id, and keeps `sha256` and `appProperties`;
  - `delete` trashes by default, `permanent` removes the subtree, and the root can't be deleted;
  - `move` with neither `parent` nor `name` gives `ProviderError`.
- `packages/drive/src/drive-provider.ts` (296 lines): `#withRef`, `#statById`, `#findChildren`, and `this.#creates` (`CreateContext`).
- `packages/drive/src/api/creates.ts`: `createWithReconcile(ctx, operation, parentId, name, create, matches)`, because copy is a create.
- `packages/drive/test/drive/fake-drive.ts`: GET, POST and PATCH routes for files and uploads.

## Knowledge Registry
- **Fake failure injection** must be proved by mutation, and matched by what tells the request apart (method, or the first query parameter).
- **A mutation only counts if the mutated value reaches what the test observes.** A retried error gets swallowed.
- **Fake `fetch`:** no `as typeof globalThis.fetch` assertion.
- **Background shells start on Node 24.**

## Architecture Decisions
- **Endpoints.** `[assumed]` These come from the Drive v3 reference and are first exercised for real in FN-15 and FN-16.
  - `move`: `PATCH files/<id>?addParents=<new>&removeParents=<old>&fields=<FILE_FIELDS>`, with a JSON body `{ name }` when renaming (or `{}`).
  - `copy`: `POST files/<id>/copy?fields=<FILE_FIELDS>`, with a JSON body `{ name, parents: [targetId], appProperties }`. `appProperties` come from the source `stat`, so `byosSha256` is kept explicitly instead of trusting Drive to copy it.
  - trash: `PATCH files/<id>?fields=<FILE_FIELDS>`, with a JSON body `{ trashed: true }`.
  - permanent: `DELETE files/<id>`, where a 204 means success.
- **`move(ref, { parent?, name? })`:**
  - neither given: `ProviderError('move needs a new parent, a new name, or both', { retryable: false })`;
  - resolve `ref` with `#withRef` and `#statById`; missing gives `NotFoundError`. The source `parents[0]` is the current parent;
  - the target parent is `parent` resolved by `#withRef`, or the current parent;
  - **no-op:** the same parent and the same name return the source `FileStat`, with no request;
  - refuse to move a folder into itself or its descendants: walk the target's `parents` chain up to the root with `#statById`, and if the source id appears, give `ProviderError(..., { retryable: false })`;
  - clash: `#findChildren(targetParent, name)` finding an item with a different id gives `ConflictError('<name> already exists')`;
  - then send the PATCH through `client.json` (with retry). It is idempotent: repeating it lands in the same state.
- **`copy(ref, { parent, name? })`:**
  - a folder source gives `ProviderError('folders cannot be copied in v1', { retryable: false })`;
  - a clash in the target gives `ConflictError`;
  - the create runs through `createWithReconcile(this.#creates, 'drive.copy', targetId, name, () => client.jsonOnce(...POST copy...), found => !found.isFolder && found.sha256 === source.sha256)`.
- **`delete(ref, { permanent? })`:**
  - resolve the id; if it equals the configured root id (or `'root'`), give `ProviderError('the root cannot be deleted', { retryable: false })`;
  - trash by PATCH `{ trashed: true }` through `client.json`, which is idempotent;
  - `permanent` uses `client.rawOnce`-style handling. A new helper in `client.ts`, `client.noContent(operation, url, init)`, runs inside retry, accepts 204 or 200, maps other statuses, and returns `void`. A 404 on a permanent delete *after a retry* means it is already gone, so it resolves.
  - It never deletes anything other than the resolved id.
  - After a successful `move`, `delete` or `copy`, call `this.#resolver.invalidate()` for the affected path when the ref was a path. Simplest correct rule: when `ref` was `{ path }`, invalidate that path, and for `move` also the source path.
- **Shared contract suite.** The acceptance criteria want the fake and `DriveProvider` to pass the same suite.
  - It lives in `packages/core/src/testing/contract.ts` and is exported from `@byos/core/testing` as `storageContract(): ContractCase[]`.
  - Each case is `{ name: string; run: (harness: { provider: StorageProvider; root: string }) => Promise<void> }`.
  - **It must not import vitest or `node:*`:** it ships in `dist` and must stay Node-free, so the portability bundle test covers it. It uses a local `check(condition, message)` that throws `Error`, and a local `rejectsWith(promise, ErrorClass)`.
  - **Cases, at least one per operation:**
    - `put` then `stat` round-trips `sha256` and size;
    - `put` without `overwrite` on an existing name gives `ConflictError`;
    - `list` shows the children and hides trashed ones;
    - `get` returns the bytes;
    - `mkdir` is idempotent;
    - `move` renames and keeps the id; `move` onto a clash gives `ConflictError`; `move` to the same parent and name is a no-op;
    - `copy` gives a new id with the same `sha256`; `copy` of a folder gives `ProviderError`;
    - `delete` makes `stat` give `undefined`; `delete` with `permanent` on a trashed file works;
    - a missing id gives `NotFoundError` on `get`, `move`, `copy` and `delete`.
  - Tests: `packages/core/test/contract.test.ts` runs every case against `new MemoryProvider()`, and `packages/drive/test/drive/contract.test.ts` against `setup().provider` (fake Drive). Each is `for (const c of storageContract()) it(c.name, () => c.run(...))`.

## Files to Create
| File | Purpose |
|------|---------|
| `packages/core/src/testing/contract.ts` | `storageContract()` cases, framework-free and Node-free |
| `packages/core/test/contract.test.ts` | The contract against `MemoryProvider` |
| `packages/drive/test/drive/contract.test.ts` | The contract against `DriveProvider` + fake Drive |
| `packages/drive/test/drive/move-copy-delete.test.ts` | Drive-specific cases: request shapes (addParents/removeParents, copy body with `appProperties`, PATCH `trashed`, DELETE), PermissionError on a 403 `appNotAuthorizedToFile`, root refusal, lost-copy reconciliation, a 404 after a retried permanent delete resolving |

## Files to Modify
| File | Changes |
|------|---------|
| `packages/core/src/testing/index.ts` | Export `storageContract` and its types |
| `packages/drive/src/drive-provider.ts` | Real `move`, `copy`, `delete`; remove `notImplemented` once unused. If it passes ~300 lines, move the three bodies to a new `packages/drive/src/api/relocate.ts` (functions taking the client, the create context and the resolver callbacks), following the `api/creates.ts` pattern |
| `packages/drive/src/api/client.ts` | `noContent(operation, url, init)` for the 204 delete |
| `packages/drive/test/drive/fake-drive.ts` | Routes: `PATCH /drive/v3/files/<id>` (JSON: rename, `trashed`, and `addParents`/`removeParents` from the query), `POST /drive/v3/files/<id>/copy`, `DELETE /drive/v3/files/<id>` (204; children are removed with the folder), and a 403 `appNotAuthorizedToFile` for files flagged `foreign: true` |
| `packages/drive/test/drive/read-operations.test.ts` | Drop the "not implemented" case for these three |
| `issues/FN-07-drive-move-copy-delete.md` | Execution Record |

## Data Requirements
- None.

## Testing Strategy
- The contract suite runs on both providers, as above.
- Drive-specific cases in `move-copy-delete.test.ts`, each asserting on the recorded request:
  - `move` sends `addParents` and `removeParents` and keeps the id;
  - rename only: no `addParents`;
  - the same-name no-op sends no request;
  - moving into its own descendant is refused;
  - `copy` sends `appProperties.byosSha256` and the target parent;
  - a lost copy response (`failAfterApply` on `/copy?`) leaves exactly one copy;
  - trash sends PATCH `{ trashed: true }`; `permanent` sends DELETE;
  - a foreign file gives `PermissionError` with no retry;
  - deleting the root is refused with no request.
- Mutation proofs, recorded in the Execution Record:
  - make `delete` ignore `permanent` (always DELETE): the contract's trash case must fail;
  - drop the clash check in `move`: the clash case must fail on both providers.

## Implementation Order
1. **Riskiest first, the shared contract suite.** Write `contract.ts` and run it against `MemoryProvider` (it must pass as is, since the fake is the reference), then against the Drive provider, where `move`, `copy` and `delete` fail. This fixes the target before any Drive code.
2. Write the fake's routes and `client.noContent`.
3. Write `move`, `copy` and `delete` in the provider (or `api/relocate.ts`), until the contract passes on Drive.
4. Write the Drive-specific tests and the mutations.
5. `pnpm format`, then `pnpm check`.

## Security Considerations
- Trash by default. `permanent` must be explicit and is never inferred.
- The root is never deleted.
- Under `drive.file`, operating on a file the app didn't create surfaces as `PermissionError`, with no retry.

## Pattern to Copy
- `packages/drive/src/api/creates.ts` for a module that takes the client and context.
- `packages/drive/test/drive/write-operations.test.ts` for request-recording assertions.
- `packages/core/test/memory-provider.test.ts` for the semantics the contract encodes.

## Verification
- Command: `pnpm check` (green, including both contract test files and the root portability test, which now bundles a `core/testing` that contains `contract.ts`).
- Command: `grep -rn "node:\|console\.\|vitest" packages/core/src packages/drive/src` (no output).
- Command: `wc -l packages/drive/src/drive-provider.ts` (≤ ~300).
- Done when: check green and both mutation proofs fail as expected and are restored. The delivery carries the check counts per step, the mutation results and the verify-it report.

## Out of Scope
- Recursive folder copy, the Changes API, restoring from trash, and shared drives.
- CLI commands (`mv`, `cp`, `rm` are FN-11).

## Checkpoint
- `Checkpoint: nao`

---

# Execution Record

- Branch `feat/FN-07-drive-move-copy-delete`, executed 2026-11-21.
- Step 1 (riskiest): `storageContract()` (`@byos/core/testing`, framework-free and Node-free, 14 cases) passes on `MemoryProvider` as written, and on `DriveProvider` it failed for exactly the 8 cases that needed `move`, `copy` and `delete` before any Drive code existed.
- Implementation: `api/relocate.ts` (`move`, `copy`, `remove`), `DriveClient.noContent` (retry, and a 404 on a repeated permanent delete counts as done), `copyUrl` in `api/files.ts`, and the fake's PATCH, copy and DELETE routes plus `foreign` files that answer 403 `appNotAuthorizedToFile`.
- Mutation proofs (restored, `cmp` equal):
  - `delete` always sends DELETE: the Drive PATCH test and the contract's "permanent on a trashed file" fail. The contract's "trashes by default" case alone doesn't tell trash from a permanent delete, because `stat` is `undefined` after both; the request-shape test and the trashed-then-permanent case do.
  - No clash check in `move`: the Drive clash test and the contract's clash case fail.
- Problems found and fixed while running:
  - The contract's `copy` case passed a made-up `sha256`, which `DriveProvider.put` rightly refuses (it computes and compares). The case now computes the real hash with Web Crypto.
  - Three Drive tests failed in a chain with no apparent link: the fake kept the objects of a module-level fixture array, so the first `move` test renamed and re-parented `f1` for the following tests. The fake now copies its initial files.
- Deviations from the plan:
  - The stale "not implemented" test in `read-operations.test.ts` was removed, as planned; no `notImplemented` helper remains.
  - `drive-provider.ts` is 308 lines (the plan said ≤ ~300) even with the three operations in `api/relocate.ts`.
  - `[assumed]`, first exercised for real in FN-15 and FN-16: the PATCH, copy and DELETE shapes, and that comparing the target parent with `parents[0]` works when the target is Drive's `root` alias (real Drive reports the real root id in `parents`). If a move to the Drive root misbehaves there, normalise the alias with one `stat('root')`.
- `pnpm check`: build, lint (ESLint 0 warnings, Prettier clean), typecheck and tests green: 269 passed (83 in core, 159 in drive, 2 in cli, 25 in the root suite). `grep -rn "node:\|console\.\|vitest" packages/core/src packages/drive/src` prints nothing.
- After the independent verification (94, no vetoes):
  - The contract's `put` case now also checks that the hash round-trips, and the `delete` case is named for what it proves.
  - The `copy` reconciliation matcher compares the hash when the source has one.
  - `move` refuses the root (a Drive-side guard with a test; `MemoryProvider` has no such guard).
- Final `pnpm check` after the fixes: green, 270 tests (83 in core, 160 in drive, 2 in cli, 25 in the root suite).
