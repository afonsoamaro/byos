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
