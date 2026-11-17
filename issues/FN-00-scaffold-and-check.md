# [FN-00] Monorepo scaffold, check and CI

## Type
Functional

## Description
Set up the pnpm monorepo with `packages/core`, `packages/drive` and `packages/cli`, a single `check` command (lint, typecheck, test, build for every package) that is green on the empty packages, and CI that runs the same command. No feature code yet.

## User Flow
1. A contributor clones the repo, runs `pnpm install` and `pnpm check`, and gets green.
2. CI runs the same `pnpm check` on every pull request and on every push to `main`.

## Requirements
- pnpm workspace with three packages, named `@byos/core`, `@byos/drive`, `@byos/cli` (final npm scope is confirmed in FN-19; names are easy to change before the first publish).
- ESM-only TypeScript, `strict`, `exactOptionalPropertyTypes`, one `tsconfig.base.json`.
- ESLint with `typescript-eslint` `strictTypeChecked` (use `defineConfig` from `eslint/config`, `projectService: true`, and `disableTypeChecked` for config files).
- Vitest in each package with at least one real test (not an empty suite): for example, a test that the package's public entry exports what it declares.
- Build with `tsc` to ESM plus `.d.ts` per package (decided in planning, 2026-11-15: a library emitted file by file needs no bundler; one less dependency).
- **Portability guard**: `core` and `drive` must not import Node built-ins. Enforce with an ESLint rule (`no-restricted-imports` for `node:*` and the bare built-in names) scoped to those two packages, and a test that bundles each for a browser target and fails on any Node import.
- `devEngines.runtime` pinned to the Node LTS major, `.nvmrc` for local use, `packageManager` with the pnpm version.
- CI: `.github/workflows/ci.yml`, one job, runs `pnpm check`; `pnpm/setup` pinned by commit SHA with the version in a comment, `require-lockfile: true`. First-party GitHub actions stay on their major tag.
- `.github/dependabot.yml` with `npm` and `github-actions`.
- `LICENSE` (MIT), `.gitignore`, `.editorconfig`, and a README stub for a stranger (what it is, status "pre-alpha", how to run check).
- `.gitleaksignore` only if needed, and `gitleaks dir . -v` clean.

## Scenarios
### Happy Path
- `pnpm check` runs lint, typecheck, test and build in every package and exits 0.
### Edge Cases
- A test in `core` that adds `import fs from "node:fs"` makes lint fail (prove the guard by mutation, then revert).
### Error Handling
- If `pnpm check` is red, the issue isn't done.

## Data Requirements
- None.

## External Dependencies
- Versions current on 2026-11-15 are in the plan below; re-check them at implementation.

## Acceptance Criteria
- [ ] **Every key dependency installed here (Node LTS, pnpm, TypeScript, typescript-eslint, ESLint, Prettier, Vitest, Vite, esbuild, commander, `@types/node`, and the `pnpm/setup` action) is pinned to its current stable version, verified against the registry when this issue is implemented, not recalled from memory and not copied blindly from `SPECS.md` or this plan.** Zod and p-limit are not installed here; the issue that first uses each pins it the same way. TypeScript stays on 6.0.x only while `typescript-eslint` still declares `typescript <6.1.0`; re-check the peer and record the result here.
- [ ] `pnpm check` is green on the three packages, each with at least one real test.
- [ ] The Node built-in import guard fails when violated (shown by a temporary mutation).
- [ ] CI workflow and `dependabot.yml` exist, with third-party actions pinned by SHA.
- [ ] MIT `LICENSE` and README stub exist.
- [ ] `gitleaks dir . -v` is clean.

## Dependencies
- None.

---

# Implementation Plan

Planned 2026-11-15. Status: planned.

## Prerequisites
- Node 26 LTS active in the shell (`v26.13.1` on 2026-11-15) before any `pnpm` command, or pnpm stops with `ERR_PNPM_BAD_RUNTIME_VERSION`.
- pnpm 12 available locally (`pnpm -v`; 12.20.0 installed, 12.21.0 latest on 2026-11-15).
- No git yet: FN-00b runs `git init` after this issue. Don't run `git init` here.
- Move nothing from the project root except what this plan says. `SPECS.md`, `DISCOVERY.md`, `issues/` stay where they are; the old handoff files move in FN-00b.

## Reusable Code Found
The project has no code yet. The setup follows patterns already validated in other TypeScript packages; each is spelled out in this plan, so nothing outside the repo is required. A maintainer-only note with the local sources lives in `issues/_local/FN-00-sources.md` (gitignored); read it if present, ignore its absence.

## Knowledge Registry
Validated lessons this plan applies (sources in the local note):
- TypeScript stays on 6.0.x: `typescript-eslint` 8.72.2 still declares `typescript: >=4.8.4 <6.1.0`; on 7.x typecheck passes and lint silently breaks (re-checked 2026-11-15).
- `strictTypeChecked` rejects a config written with `tseslint.config(...)` and `allowDefaultProject`: use `defineConfig` from `eslint/config`, `projectService: true`, and `disableTypeChecked` for `**/*.mjs`.
- Vitest 5 does not bring `vite`; it's a peer and must be installed.
- Type-aware lint needs sibling packages already built, so `check` builds first.
- A file listed in `allowDefaultProject` that is also in a tsconfig breaks lint; this plan uses no `allowDefaultProject`.
- `.claude/**` in ESLint `ignores`, or a worktree of another session inside the repo enters the lint.
- `pnpm/setup` v3 has real `cache` and `require-lockfile` inputs. Resolve its SHA with `gh api repos/pnpm/setup/commits/<tag> --jq .sha`; `git/ref/tags/<tag>` returns the annotated tag object, not the commit.
- pnpm 12: `allowBuilds` in `pnpm-workspace.yaml`, each package decided `true`/`false` (replace the placeholder pnpm writes, never add a duplicate key); a package with no dependencies isn't written to the lockfile `importers` and breaks `--frozen-lockfile` (add `packages/<name>: {}` by hand if so); `minimumReleaseAge` blocks versions under 24 h old (use the previous version; never accept the generated `minimumReleaseAgeExclude`); pnpm refuses to run when the shell's Node doesn't match `devEngines.runtime`.
- A function returned from vitest's `beforeEach` runs as teardown.

## Architecture Decisions
- **Build with `tsc`, not tsup.** Each package emits `dist/` file by file with `tsc -p tsconfig.build.json`. A library doesn't need bundling, and it's the portfolio's existing TS-package pattern. `SPECS.md` was updated.
- **`check` builds first**: `pnpm build && pnpm lint && pnpm typecheck && pnpm test`. `drive` and `cli` import `@byos/core` through its `dist/` exports, and type-aware lint fails without it (registry). The build is still part of the gate.
- **Packages resolve each other through `exports` → `dist`**, with `workspace:*` dependencies. No TS project references, no custom source conditions (a single convention, the one the registry has validated).
- **Node-free guard, three layers, for `core` and `drive`:**
  1. `tsconfig.json` of each has `"types": []` and `"lib": ["es2024", "dom"]`. Node globals (`Buffer`, `process`) fail typecheck in `src`; `fetch`, `ReadableStream`, `crypto.subtle` come from `dom` lib types, which React Native also provides at runtime.
  2. ESLint `no-restricted-imports` on `packages/core/src/**` and `packages/drive/src/**`, built from `builtinModules` of `node:module` plus the `node:*` pattern.
  3. `tests/portability.test.ts` at the root bundles each package's `dist/index.js` with esbuild, `platform: 'browser'`, `bundle: true`, `write: false`, and expects no errors. This catches a Node import that arrives through a dependency, which layers 1 and 2 can't see.
- **Tests import from `src`**, not from `dist`, except the portability test, which deliberately checks the built output.
- **Test files get Node types through a nested `test/tsconfig.json`** in `core` and `drive`, so `src` stays without Node types while vitest's typings (which reference Node) still type-check. The ESLint project service picks the nearest `tsconfig.json`, so test files resolve to `test/tsconfig.json` automatically.
- **Pinned exact versions** (no `^`) in every `package.json`, except `devEngines.runtime` (`^26`) and peer ranges, which don't exist yet.
- **CLI binary**: `packages/cli/src/bin.ts` starts with `#!/usr/bin/env node` (tsc keeps the shebang), `bin: { "byos": "./dist/bin.js" }`. The program is built in `src/program.ts` so tests call it without spawning.
- **Prettier** is part of lint (`prettier --check .`), as in the template. Markdown and `issues/` are ignored by Prettier, so planning edits never break CI.

## Files to Create
| File | Purpose |
|------|---------|
| `package.json` | Workspace root: scripts, devDependencies, `packageManager`, `devEngines` |
| `pnpm-workspace.yaml` | `packages/*`, `catalog` for TypeScript, `allowBuilds` decisions |
| `.nvmrc` | `26` for local `nvm use` |
| `tsconfig.base.json` | Shared strict compiler options |
| `tsconfig.json` | Root typecheck of `vitest.config.ts` and `tests/` |
| `eslint.config.mjs` | Flat config, `strictTypeChecked`, Node-free import guard |
| `.prettierrc`, `.prettierignore` | Formatter config |
| `vitest.config.ts` | Root vitest project for `tests/**` |
| `tests/portability.test.ts` | Bundles `core` and `drive` `dist` for the browser with esbuild |
| `packages/core/package.json` | `@byos/core`, ESM, `exports` → `dist`, no dependencies |
| `packages/core/tsconfig.json`, `tsconfig.build.json`, `test/tsconfig.json` | Typecheck (no Node types), build, test typecheck |
| `packages/core/src/index.ts` | `export const PACKAGE_NAME = '@byos/core';` |
| `packages/core/test/index.test.ts` | Entry exports `PACKAGE_NAME` equal to `package.json` name |
| `packages/drive/...` | Same five files as `core`, name `@byos/drive`, dependency `"@byos/core": "workspace:*"`; `src/index.ts` also re-exports nothing from core yet but imports `PACKAGE_NAME as CORE` and exports `REQUIRES = [CORE]` so the cross-package resolution is exercised by build, lint and test |
| `packages/cli/package.json` | `@byos/cli`, `bin.byos`, dependencies `@byos/core`, `@byos/drive` (`workspace:*`), `commander` |
| `packages/cli/tsconfig.json`, `tsconfig.build.json` | Node types allowed |
| `packages/cli/src/program.ts` | `createProgram()` with commander: name `byos`, `--version` from `package.json` |
| `packages/cli/src/bin.ts` | Shebang, `await createProgram().parseAsync(process.argv)` |
| `packages/cli/test/program.test.ts` | Version matches `package.json`; `--help` lists the name |
| `.github/workflows/ci.yml` | One job: checkout, `pnpm/setup`, `pnpm check` |
| `.github/dependabot.yml` | npm (grouped dev tooling, TS ignore) and github-actions |
| `.gitignore` | Secrets, credentials, manifests, build output (list below) |
| `.editorconfig` | 2 spaces, LF, final newline, UTF-8 |
| `LICENSE` | MIT, `Copyright (c) 2026 Afonso Amaro` |
| `README.md` | Stub for a stranger |

### `package.json` (root)
- `"name": "byos-workspace"`, `"private": true`, `"type": "module"`, `"license": "MIT"`.
- `"packageManager": "pnpm@<latest 12.x at implementation>"` (12.21.0 on 2026-11-15; if it was published less than 24 h before, use the previous patch).
- `"devEngines": { "runtime": { "name": "node", "version": "^26", "onFail": "error" } }`.
- Scripts:
  - `build`: `pnpm -r run build` (pnpm runs workspace packages in dependency order).
  - `lint`: `eslint . --max-warnings 0 && prettier --check .`
  - `typecheck`: `tsc --noEmit -p tsconfig.json && pnpm -r run typecheck`
  - `test`: `pnpm -r run test && vitest run`
  - `check`: `pnpm build && pnpm lint && pnpm typecheck && pnpm test`
  - `format`: `prettier --write .`
- devDependencies (exact; verify each with `npm view <pkg> version` at implementation; values below are from 2026-11-15): `typescript` `catalog:` (6.0.3), `typescript-eslint` 8.72.2, `eslint` 10.14.0, `@eslint/js` 10.0.1, `eslint-config-prettier` 10.1.8, `prettier` 3.10.1, `vitest` 5.1.0, `vite` 8.3.8 (vitest peer), `esbuild` 0.28.2, `@types/node` 26.6.6 (match the Node major).

### `pnpm-workspace.yaml`
- `packages: ['packages/*']`.
- `catalog: { typescript: 6.0.3 }` with the comment explaining the typescript-eslint `<6.1.0` peer ceiling and the trigger to revisit.
- `allowBuilds`: start empty. After the first `pnpm install`, if it stops with `ERR_PNPM_IGNORED_BUILDS`, open the file and replace each placeholder with a decision and a one-line reason in a comment. Expected: `esbuild` may ask; set `esbuild: false` first (its binary comes from the platform optional dependency) and confirm the portability test still runs; switch to `true` with a reason only if esbuild then fails to start.

### `tsconfig.base.json`
- `target` and `lib` `es2024`, `module`/`moduleResolution` `nodenext`, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`, `isolatedModules`, `skipLibCheck`, `forceConsistentCasingInFileNames`.

### `packages/core/tsconfig.json` (same for `drive`)
- Extends `../../tsconfig.base.json`; `"lib": ["es2024", "dom"]`, `"types": []`, `"noEmit": true`, `"rootDir": "src"`, `"include": ["src"]`.
- `tsconfig.build.json`: extends `./tsconfig.json`, `noEmit: false`, `outDir: dist`, `declaration`, `declarationMap`, `sourceMap`.
- `test/tsconfig.json`: extends `../tsconfig.json`, `"types": ["node"]`, `"rootDir": ".."`, `"include": [".", "../src"]`.
- `package.json` scripts: `build`: `rm -rf dist && tsc -p tsconfig.build.json`; `typecheck`: `tsc -p tsconfig.json && tsc -p test/tsconfig.json`; `test`: `vitest run`. `exports: { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } }`, `files: ["dist"]`, `type: module`, `sideEffects: false`, `version: 0.0.0`, `license: MIT`, `repository` with `directory`. devDependencies: `vitest`, `vite`, `@types/node` (same exact versions as root) and `typescript: catalog:`.

### `packages/cli/tsconfig.json`
- Extends base, `"types": ["node"]`, `include: ["src", "test"]`, `noEmit`; build config emits `src` only.

### `eslint.config.mjs`
- Shape: `ignores: ['**/dist/**', '**/coverage/**', '.claude/**', 'docs/history/**']`, `js.configs.recommended`, `tseslint.configs.strictTypeChecked`, `projectService: true`, `tsconfigRootDir: import.meta.dirname`, the `consistent-type-imports` and `no-unused-vars` rules, `disableTypeChecked` for `**/*.mjs`, `prettier` last.
- Node-free block: `files: ['packages/core/src/**/*.ts', 'packages/drive/src/**/*.ts']`, `no-restricted-imports` with `paths` built from `builtinModules` (each with message "core and drive must run outside Node (React Native, browser): no Node built-ins") and `patterns: [{ group: ['node:*'], message: same }]`.

### `tests/portability.test.ts`
- For each of `packages/core/dist/index.js` and `packages/drive/dist/index.js`: `await build({ entryPoints: [file], bundle: true, platform: 'browser', format: 'esm', write: false, logLevel: 'silent' })`; assert `result.errors` is empty. If the build throws, the test fails with esbuild's message (it names the Node import).
- A sanity case proves the guard bites: bundle an inline `stdin` entry `import 'node:fs'` with the same options and assert it rejects. This keeps the test from passing vacuously.
- `vitest.config.ts` at the root: `test.include: ['tests/**/*.test.ts']`. Root `tsconfig.json` includes `vitest.config.ts` and `tests`, with `types: ["node"]`.

### `.github/workflows/ci.yml`
- Triggers `pull_request` and `push` to `main`; `permissions: contents: read`; `concurrency` per ref with cancel.
- `actions/checkout@v7` with `persist-credentials: false` (v7.0.1 is latest on 2026-11-15; GitHub-owned actions stay on the major).
- `pnpm/setup@731dfb6463bbd11c11fd0ee11fe00ed0e36d48a1 # v3.2.0` (resolved with `gh api repos/pnpm/setup/commits/v3.2.0 --jq .sha` on 2026-11-15; re-resolve if a newer v3 exists at implementation). Inputs: `cache: true`, `require-lockfile: true`. No `runtime` input: Node comes from `devEngines.runtime`.
- `run: pnpm check`.
- A comment block explaining why the third-party action is pinned by SHA (a tag can be moved by its publisher, and the job runs with the repo token) and where the Node and pnpm versions come from (`devEngines.runtime` and `packageManager`).

### `.github/dependabot.yml`
- npm at `/`, weekly, limit 5, group `dev-tooling` (eslint, `eslint-*`, `@eslint/*`, typescript-eslint, prettier, vitest, vite, esbuild, `@types/node`), ignore `typescript >=6.1.0` with the comment.
- github-actions at `/`, weekly.

### `.gitignore`
- `node_modules/`, `dist/`, `coverage/`, `*.tsbuildinfo`, `.env`, `.env.*`, `!.env.example`, `client_secret*.json`, `*.byos`, `tokens/`, `*.sqlite`, `*.sqlite-*`, `*.db`, `.DS_Store`, `.claude/worktrees/`, `issues/_local/` (maintainer-only planning notes that name local sources). The credential entries are here because the repo will be public (FN-00b security gate).

### `README.md`
- Line 1 placeholder comment for the header image (PP-01 fills it).
- What BYOS is (two sentences from `SPECS.md` Overview), status "pre-alpha, nothing usable yet", what it deliberately won't do (sync, full-Drive access), requirements (Node 26, pnpm 12), `pnpm install` and `pnpm check`, license MIT. No personal paths, no other project names.

## Files to Modify
| File | Changes |
|------|---------|
| `issues/_index.md` | FN-00 status to `done` at delivery |

## Data Requirements
- None.

## Testing Strategy
- `core` and `drive`: `test/index.test.ts` reads the package's own `package.json` (`import pkg from '../package.json' with { type: 'json' }`, needs `resolveJsonModule` in the test tsconfig) and asserts `PACKAGE_NAME === pkg.name`. `drive` also asserts `REQUIRES` contains `'@byos/core'`, which proves the workspace link and the build order.
- `cli`: `createProgram().version()` equals `package.json` version; `createProgram().helpInformation()` contains `byos`.
- Root: `tests/portability.test.ts` as described, including the self-check.
- Mutation proof of the guard (do it, record the output, revert): add `import { readFileSync } from 'node:fs'; export const x = readFileSync;` to `packages/core/src/index.ts`. Expect three failures: typecheck (no Node types), lint (`no-restricted-imports`), portability test (esbuild can't resolve `node:fs` for the browser). Revert and re-run.

## Implementation Order
1. **Riskiest first: toolchain resolution.** Root `package.json`, `pnpm-workspace.yaml`, `.nvmrc`, the three `packages/*/package.json` with dependencies, then `pnpm install`. Resolve `allowBuilds`, the 24 h release-age window, and the `importers` gap now; then `pnpm install --frozen-lockfile` must pass. A version problem found here costs minutes; found after writing configs it costs a re-plan.
2. tsconfigs (base, root, per package, test).
3. Package sources and tests (`index.ts`, `program.ts`, `bin.ts`, tests).
4. `eslint.config.mjs`, `.prettierrc`, `.prettierignore`, `vitest.config.ts`, `tests/portability.test.ts`.
5. `pnpm check` until green; then the mutation proof and revert.
6. `.github/workflows/ci.yml`, `.github/dependabot.yml`, `.gitignore`, `.editorconfig`, `LICENSE`, `README.md`.
7. `gitleaks dir . -v` (expect clean; `node_modules` and `dist` are scanned too, so if a fixture inside a dependency trips it, record the finding and scope the command to the repo files instead of adding ignores).
8. Final `pnpm check`, record each step's counts here.

## Security Considerations
- The repo will be public. No personal paths, emails or other project names in any created file; `LICENSE` copyright holder is the only name.
- `.gitignore` covers credential and token shapes before any code that produces them exists.
- CI runs with `contents: read` and `persist-credentials: false`; third-party actions pinned by SHA.
- `allowBuilds` denies install scripts unless a reason says otherwise.

## Pattern to Copy
- No sibling exists in this repo yet. The shapes to follow are spelled out per file above; the local note names the original files.

## Verification
- Command: `pnpm install --frozen-lockfile && pnpm check` (expected: exit 0, lint 0 errors 0 warnings, typecheck 0 errors, tests pass in core, drive, cli and root portability, build emits `dist/` in the three packages).
- Command: `gitleaks dir . -v` (expected: no leaks found).
- Manual check: `node packages/cli/dist/bin.js --version` prints `0.0.0`.

## Out of Scope
- `git init`, GitHub repo, first push, secret scanning settings, gitleaks in CI: FN-00b.
- Moving the old design handoff files: FN-00b.
- Any real type, interface or error from FN-01; the only exports are `PACKAGE_NAME`, `REQUIRES` and `createProgram`.
- Zod, p-limit, any Google library, any HTTP client.
- Logo, header image, CLI output design: PP-01, PP-02.
- Changesets or any release tooling: FN-19.
- Bumping TypeScript to 7.x.

## Checkpoint
- `Checkpoint: nao`.

---

# Execution Record (2026-11-16)

## Versions pinned (checked against the registry on 2026-11-16)
- Node 26.13.1 (`devEngines.runtime ^26`), pnpm 12.21.0, TypeScript 6.0.3, typescript-eslint 8.72.2, ESLint 10.15.0, `@eslint/js` 10.0.1, eslint-config-prettier 10.1.8, Prettier 3.10.1, Vitest 5.1.0, Vite 8.3.8, esbuild 0.28.2, commander 15.1.0, `@types/node` 26.6.6, `pnpm/setup` v3.2.0 (`731dfb6463bbd11c11fd0ee11fe00ed0e36d48a1`), `actions/checkout@v7` (v7.0.1).
- Deviation from the plan: ESLint 10.15.0 instead of 10.14.0 (published 2026-11-13, outside the 24 h window).
- TypeScript peer re-check: `typescript-eslint` 8.72.2 still declares `typescript: >=4.8.4 <6.1.0`, and TypeScript `latest` is 7.0.2, so the catalog stays on 6.0.3.

## Toolchain resolution
- The first install stopped on `ERR_PNPM_IGNORED_BUILDS` for esbuild and wrote no placeholder. Set `esbuild: false`; esbuild still builds (its binary comes from the platform optional dependency), and the portability test runs.
- All three packages are in the lockfile `importers`; `pnpm install --frozen-lockfile` passes.

## Portability guard, mutation proof
Added `import { readFileSync } from 'node:fs'; export const x = readFileSync;` to `packages/core/src/index.ts`:
- Typecheck: `TS2591: Cannot find name 'node:fs'`, exit 2.
- Lint: `no-restricted-imports` with the Node-free message, exit 1.
- Portability test: `core` and `drive` both fail with `Could not resolve "node:fs"`. `drive` fails through its dependency on `core`, which is the transitive case only this layer sees.
Reverted, then re-ran check.

## Verification
- `pnpm install --frozen-lockfile && pnpm check`: exit 0. Build emits `dist/` in all three packages. Lint: 0 errors, 0 warnings, Prettier clean. Typecheck: 0 errors (root plus three packages). Tests: core 1, drive 2, cli 2, root portability 3, all passing.
- `gitleaks dir . -v`: no leaks found.
- `node packages/cli/dist/bin.js --version` prints `0.0.0`.
