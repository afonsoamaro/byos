# FN-00b verification

Verdict: pass, score 98/100, no vetoes, one round. Verified 2026-11-18 by an independent verifier with no access to the implementation session.

The verifier checked the GitHub state read-only. It re-ran `gitleaks git . -v` (2 commits, no leaks), `gitleaks dir . -v` (no leaks), a credential and personal-path grep over the tracked files (clean), and `pnpm install --frozen-lockfile && pnpm check` (build, lint, typecheck and 8 tests, all passing).

## Acceptance criteria
- [x] Local repo on `main` with the scaffold, spec, discovery and issues: bootstrap commit `3ce53e7`, 66 files, noreply author and committer.
- [x] `afonsoamaro/byos` is public, with secret scanning and push protection enabled.
- [x] Security gate passed before the first push, with gitleaks 8.30.1 locally (1 commit scanned, no leaks, in both `git` and `dir`). Results are in the issue's Execution Record.
- [x] CI runs gitleaks on pull requests: run `44207919771` (event `pull_request`, PR #1) had `check` pass and `secrets` pass, with checksum `OK`, 2 commits scanned and no leaks.
- [x] CI ran on the push to `main` and is green: run `44108101164`, with `check` and `secrets` both successful.
- [x] Old design handoff lives in `docs/history/`, with the superseded note.
- [x] Ruleset `27482952` on `main`: deletion, non-fast-forward, pull request (merge commit only, 0 approvals) and required checks `check` and `secrets`.

## Findings (both low, addressed here)
- The PR's own CI run id was missing from the record. It's listed above.
- Gate step 1 had no commit count or gitleaks version. Both are listed above.

## Metrics
Approximate: the bootstrap, the repo creation and the first push happened before the branch existed. The branch part cost $6.08 over 17 active minutes.
