# [FN-19] First npm release

## Type
Functional

## Description
Publish `core`, `drive` and `cli` to npm as `0.1.0` once the first consumer has run (FN-16), so the CLI can be installed with `npm i -g` on any machine, including the Windows box and the VPS. Resolves SPECS open question 5 (npm scope).

## User Flow
1. Maintainer merges a release PR; CI publishes the three packages with provenance.
2. A user runs `npm i -g @byos/cli` and `byos doctor`.

## Requirements
- Confirm ownership of the `@byos` npm org; if unavailable, pick the fallback scope, rename packages, and record the decision here and in SPECS.
- Versioning and changelog with a release tool (evaluate Changesets at its current version) or a minimal manual flow; decide here.
- Publish from CI with npm provenance (OIDC trusted publishing), never from a laptop token stored in the repo.
- `package.json` metadata: `repository`, `license`, `engines`/`devEngines`, `files` allow-list (no tests, fixtures or sources maps with secrets), `bin` for the CLI.
- Run `/deploy-check` before the first publish (gitleaks history and working tree, SAST); release-level checks: `pnpm audit`, lockfile committed, `/security-review` on the release diff.
- Install smoke on Windows and macOS from the published package.

## Scenarios
### Happy Path
- `npm i -g` from the registry, `byos --version` prints `0.1.0`.
### Edge Cases
- Package tarball contains only `dist`, README, LICENSE (checked with `npm pack --dry-run`).
### Error Handling
- Publish failure in CI leaves no partial release (all three or none, documented order: core, drive, cli).

## Data Requirements
- None.

## External Dependencies
- npm registry, GitHub Actions OIDC.

## Acceptance Criteria
- [ ] npm scope ownership confirmed and recorded.
- [ ] Release workflow publishes with provenance from CI.
- [ ] `npm pack --dry-run` contents checked for each package.
- [ ] `/deploy-check` and `pnpm audit` clean before publishing.
- [ ] Install smoke from the registry on Windows and macOS.

## Dependencies
- FN-16, FN-18.

---

# Implementation Plan

## Decisions (owner, 2026-11-21)
- **Scope:** publish under the **owner's personal npm scope**, not `@byos`. Unscoped `byos` is taken, and owning a `byos` org was not pursued.
  - The package names are `@<npm-user>/byos-core`, `@<npm-user>/byos-drive` and `@<npm-user>/byos-cli`.
  - The CLI binary stays `byos`.
  - `<npm-user>` is the owner's npm username, confirmed at execution with `npm whoami` on the owner's machine and recorded here and in `SPECS.md` (Open Question 5, resolved).
- **Release flow:** **manual and tag-driven**.
  - One version for all three packages, and a hand-written `CHANGELOG.md`.
  - A workflow triggered by a `v*` tag publishes from CI with npm provenance (OIDC trusted publishing).
  - No release tool dependency (Changesets 3.0.3 was evaluated and not adopted).

## Prerequisites
- FN-16 (a real run on Windows) and FN-18 (README and setup doc) done.
- **Owner steps on npmjs.com:** confirm the username, and enable 2FA for writes. **Trusted publishing:** at execution, read npm's current docs ("Trusted publishing for npm packages") to learn whether a trusted publisher can be configured **before** a package's first version exists.
  - If it can, configure it for each of the three names: GitHub repository, workflow `release.yml`, no environment.
  - If it can't, the **first** publish of each package is done by the owner from their own machine, interactively, with 2FA and no token stored anywhere. The trusted publisher is then configured, and every later release goes through CI only.
  - Record which path happened.
- Branch `chore/FN-19-release` from an up-to-date `main`. Node 26 in every shell, background ones included.

## Priorities
1. Nothing secret or private in the published tarballs, and no long-lived npm token in the repo or CI.
2. Releases are reproducible from a tag in CI, with provenance.
3. The acceptance criteria.

## Reusable Code Found
- `.github/workflows/ci.yml`: the `check` job (`pnpm/setup@731dfb6463bbd11c11fd0ee11fe00ed0e36d48a1 # v3.2.0`, which reads `devEngines` and `packageManager`) and the pinned gitleaks job. The release workflow copies the setup steps; it doesn't reinvent them.
- `packages/*/package.json`: `files: ["dist"]`, `exports`, `bin` (CLI), `repository`, `license`.
- The `deploy-check` skill: gitleaks over history and the working tree, SAST, and the authorization and secrets checklist.

## Knowledge Registry
- **A third-party action** is pinned by SHA with the version in a comment. GitHub's own actions stay on their major.
- **`pnpm/setup` reads `devEngines.runtime`, not `.nvmrc`.**
- **Background shells start on Node 24.**

## Architecture Decisions
- **Rename the packages.** Every `@byos/core`, `@byos/drive` and `@byos/cli` in package names, imports, `tests/portability.test.ts`, docs, README and `SPECS.md` becomes `@<npm-user>/byos-core` (and so on).
  - Do it with one scripted replace over tracked files (`git grep -l '@byos/' | xargs sed -i ''` on macOS), excluding `issues/` history text, which keeps the old names as history.
  - Then `pnpm install` regenerates the workspace links and the lockfile.
  - **It must land as its own commit before any release work**, and the full `pnpm check` must be green right after it.
- **Package metadata:** in each package, set `version: 0.1.0`, `repository` (with `directory`), `license: MIT`, and `engines: { node: ">=26" }`, alongside the workspace `devEngines`.
  - The CLI keeps `bin: { byos: './dist/bin.js' }`. Its shebang is already in `src/bin.ts`; check that `dist/bin.js` keeps it.
  - `publishConfig: { access: 'public', provenance: true }`.
- **Tarball contents:**
  - each package gets a short `README.md` (one paragraph and a link to the root README) and a `LICENSE` copy, committed, because npm includes them only from the package dir. The root `LICENSE` stays canonical, and a comment in each package README says so;
  - `files: ["dist"]` stays;
  - `npm pack --dry-run` per package must list only `package.json`, `README.md`, `LICENSE` and `dist/**`. Source maps may stay; check that none contains an absolute path (`grep -r "/Users/\|C:\\\\" dist/` gives no output).
- **Workflow `.github/workflows/release.yml`:**
  - `on: push: tags: ['v*']`, with `permissions: { contents: read, id-token: write }`;
  - jobs: checkout (`fetch-depth: 0`), `pnpm/setup` (same SHA as `ci.yml`), `pnpm check`;
  - a guard step checks that the tag equals each package's `version`, else fails;
  - then `pnpm -r publish --access public --no-git-checks` with `NPM_CONFIG_PROVENANCE: 'true'`. pnpm publishes in topological order (core, drive, cli) and rewrites `workspace:*` to the real version;
  - `[assumed]` pnpm 12's publish uses npm's OIDC token exchange for trusted publishing. Verify at execution with the docs and a first CI run; if it doesn't, switch that step to `npm publish --provenance --access public` per package after `pnpm pack`, and record it.
  - **Partial failure:** npm publishes can't be atomic across three packages. If a later package fails, fix it and re-run the workflow on the same tag: pnpm skips versions already published. This is documented in `CONTRIBUTING`-style notes in the README's release section.
- **Release checklist** (run before tagging, results recorded here):
  1. `deploy-check` (gitleaks `git` and `dir`, SAST, and the security checklist);
  2. `pnpm audit --prod` clean or explained;
  3. `/security-review` on the diff since the last release (the whole repo for the first);
  4. the `npm pack --dry-run` lists;
  5. `CHANGELOG.md` entry `0.1.0`;
  6. a release PR (version bumps and changelog) merged through the normal PR flow, then the owner pushes the tag `v0.1.0` (a git write, confirmed at the time).
- **Install smoke** (owner, after publish):
  - on macOS and on Windows, `npm i -g @<npm-user>/byos-cli`, then `byos --version` gives `0.1.0` and `byos doctor` runs;
  - record the outputs;
  - also check that the npm page shows the provenance badge.

## Files to Create
| File | Purpose |
|------|---------|
| `.github/workflows/release.yml` | Tag-triggered publish with provenance |
| `CHANGELOG.md` | Hand-written, starting at 0.1.0 |
| `packages/core/README.md`, `packages/drive/README.md`, `packages/cli/README.md` | Short package readmes |
| `packages/core/LICENSE`, `packages/drive/LICENSE`, `packages/cli/LICENSE` | Copies of the root MIT license |

## Files to Modify
| File | Changes |
|------|---------|
| All files with `@byos/` (packages, tests, scripts, docs, README, SPECS; not `issues/`) | Rename to `@<npm-user>/byos-*` (own commit) |
| `packages/*/package.json` | Name, version 0.1.0, `engines`, `publishConfig` |
| `pnpm-lock.yaml` | Regenerated after the rename |
| `SPECS.md` | Open Question 5 resolved (scope and release flow) |
| `README.md` | Install line with the real package name; release notes section |
| `issues/FN-19-npm-release.md` | Execution Record: the trusted-publishing path, checklist results, pack lists, smoke outputs |
| `issues/_index.md` | FN-19 `todo` → `planned` now; `done` only by verify-it |

## Data Requirements
- None.

## Testing Strategy
- After the rename: `pnpm check` must be green, including the portability bundle test, which references package paths, and the CLI `--version` spawned smoke.
- A workflow lint isn't available locally. Review the YAML by hand against `ci.yml`, and the first real run is the test. Optionally do a dry run on a throwaway tag `v0.1.0-rc.0`, which publishes under the `next` dist-tag (`--tag next`), if the owner wants one. That is the owner's call at execution.
- `npm pack --dry-run` outputs are recorded.

## Implementation Order
1. **Riskiest first, the rename.** Run the scripted replace, `pnpm install`, then `pnpm check`. It touches every import, so on its own it is a clean bisect point.
2. Add the package metadata, readmes and licenses, then the pack dry-runs.
3. Write `release.yml` and `CHANGELOG.md`.
4. Run the release checklist (deploy-check, audit, security-review).
5. Release PR, merge, owner tag push, CI publish. Use the first-publish fallback if npm requires it.
6. Install smoke on both OSes; record.

## Security Considerations
- No npm token in secrets or files: OIDC trusted publishing, or a one-time interactive first publish with 2FA.
- Provenance ties each version to this repository's workflow run.
- The tarballs hold only `dist`, the readme and the license, checked by `npm pack --dry-run` and a grep for absolute paths.
- `deploy-check`, `pnpm audit` and `/security-review` run before the first publish.

## Pattern to Copy
- `.github/workflows/ci.yml` for the action pins and the pnpm setup.

## Verification
- Command: `pnpm check` (green after the rename and at the end).
- Command: `cd packages/<pkg> && npm pack --dry-run` for each (recorded; only the allowed files).
- Manual: the CI publish run is green, provenance shows on npm, and the install smoke on macOS and Windows prints `0.1.0`.
- Done when: all of the above are recorded, and SPECS Open Question 5 is resolved. The delivery carries the check counts, the pack lists, the workflow run link and the smoke outputs.

## Out of Scope
- Automated version bumps or changelog generation.
- Publishing under `@byos`.
- A standalone binary (no Node).

## Checkpoint
- `Checkpoint: sim`, after step 1 (the rename changes every package's public name and import).
