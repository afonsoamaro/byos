# [FN-00b] Git init, GitHub repo and issues

## Type
Functional

## Description
Put the project under git and on GitHub before any feature work, so every later issue happens on its own branch and reaches `main` through a pull request.

## User Flow
1. `git init` with `main` as the default branch; the first commit holds the FN-00 scaffold, `SPECS.md`, `DISCOVERY.md` and `issues/`.
2. Create the GitHub repo `afonsoamaro/byos`.
3. Push, confirm CI runs on the push to `main`.

## Requirements
- **Decided 2026-11-15: the repo is public from creation.** Because it is public before any feature exists, leak prevention is doubled (see the security gate below).
- **Decided 2026-11-15: the old design handoff goes to `docs/history/`** (`byos_storage_google_drive_first_monorepo_skeleton.md`, `README_HANDOFF.md`), with a short `docs/history/README.md` saying `SPECS.md` supersedes it and that its sync design was cut on purpose. A pre-check on 2026-11-15 found only placeholders in it (`your.apps.googleusercontent.com`, `your_secret`); repeat the check at commit time.
- **Security gate before the first push** (all must pass, run in this order, results recorded here):
  1. `gitleaks git . -v` on the full history and `gitleaks dir . -v` on the working tree, both clean.
  2. Manual grep of every file to be committed for Google credential shapes (`apps.googleusercontent.com` with a real numeric prefix, `GOCSPX-`, `ya29.`, `1//0`, `AIza`), personal email addresses, absolute home paths (`/Users/`, `C:\Users\<real name>`), and names of other private projects or infra. Only the placeholders above are allowed.
  3. `.gitignore` covers `.env*` (except `.env.example`), `client_secret*.json`, `*.byos` (token exports, FN-17), `tokens/`, `*.sqlite`/`*.db` (backup manifests), `coverage/`, `dist/`.
  4. Secret scanning and push protection enabled on the GitHub repo right after creation (free for public repos), checked with `gh api repos/afonsoamaro/byos` (`security_and_analysis`).
  5. A CI step runs gitleaks on every PR, so later issues can't leak through a forgotten local check.
- If anything is found, treat it as leaked: rotate it, don't just remove the commit.
- Review every committed text for personal paths, private infra or other project names (public-repo rule): the issues and spec refer to "the bill tracker", not its repo name.
- From here on, each issue uses a dedicated branch (`feat/`, `fix/`, `chore/`) and a PR merged with a merge commit, never squash.
- Every git write (commit, push, repo creation, visibility) is confirmed with the owner first.

## Scenarios
### Happy Path
- Repo exists, CI is green on `main`, issues are visible in the repo.
### Edge Cases
- If gitleaks flags anything, treat it as leaked: rotate it, don't just remove the commit.
### Error Handling
- CI red on the first push: fix on a branch, not with a direct commit to `main`.

## Data Requirements
- None.

## External Dependencies
- GitHub (`gh` CLI), gitleaks.

## Acceptance Criteria
- [ ] Local repo on `main` with the scaffold, spec, discovery and issues committed.
- [ ] `afonsoamaro/byos` exists on GitHub as a public repo, with secret scanning and push protection enabled.
- [ ] Every step of the security gate passed before the first push, results recorded here.
- [ ] CI runs gitleaks on pull requests.
- [ ] CI ran on the push to `main` and is green.
- [ ] Old design handoff lives in `docs/history/` with the superseded note.

## Dependencies
- FN-00.

---

# Implementation Plan

Planned 2026-11-16. Status: planned.

## Prerequisites
- FN-00 done (verified 2026-11-16): `pnpm check` green, `gitleaks dir . -v` clean.
- Node 26 active (`nvm use 26`) before any `pnpm` command.
- `gh auth status` logged in as `afonsoamaro` with the `repo` scope; gitleaks 8.30.1 installed locally.
- `afonsoamaro/byos` does not exist yet on GitHub (checked 2026-11-16: 404).
- **Every git write is confirmed with the owner first**: the commit, the repo creation, the security settings, the push, the ruleset, the follow-up PR and its merge. Show what will be written and wait for a yes each time.

## Reusable Code Found
- `.github/workflows/ci.yml` (FN-00): the `check` job. This issue adds a second job and renames the first one; nothing else changes.
- `.gitignore` (FN-00) already covers every item of gate step 3; this issue only verifies it.
- `eslint.config.mjs` and `.prettierignore` (FN-00) already ignore `docs/history/**`, so the moved files never enter lint or format.

## Knowledge Registry
Validated lessons this plan applies:
- `git add` with explicit paths forgets the lockfile; list `pnpm-lock.yaml` explicitly and check `git status --short` afterwards.
- A nested git clone enters as an empty gitlink; after the commit `git ls-files -s | awk '$1=="160000"'` must be empty.
- gitleaks 8.19+ uses `gitleaks git` and `gitleaks dir` (no `detect`). A finding in a gitignored file is expected; in a tracked file it is an incident.
- First CI run: read `gh run view <id> --log` and the annotations, not only the conclusion.
- Rulesets and branch protection need a public repo on GitHub Free (they return 403 on private repos); this repo is public, so the ruleset applies.
- A third-party action is pinned by commit SHA, resolved with `gh api repos/<o>/<r>/commits/<tag> --jq .sha`.

## Architecture Decisions
- **The bootstrap commit goes straight to `main`.** An empty repository has no base to open a PR against. This matches how the earlier repos in this setup started. Every commit after it reaches `main` through a PR, and the ruleset enforces that.
- **Commit identity is the GitHub noreply address** (owner's decision, 2026-11-16): `git config user.email "63509374+afonsoamaro@users.noreply.github.com"` and `git config user.name "Afonso Amaro"`, both **local to this repo** (no `--global`). The personal address must not appear in any public commit. Check with `git log --format='%an <%ae>|%cn <%ce>'` before pushing.
- **gitleaks in CI runs the pinned release binary, verified by SHA-256, not `gitleaks/gitleaks-action`.** The action is under a non-MIT license since v2, posts PR comments by default (needs write permission), and adds a third-party runtime to the job that holds the repo token. A pinned binary plus a checksum literal in the workflow does the same scan with `contents: read`. Version 8.30.1 (latest on 2026-11-16); `gitleaks_8.30.1_linux_x64.tar.gz` SHA-256 `551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb`, checked against the release's `checksums.txt` and a local download on 2026-11-16. Dependabot doesn't bump it; a comment says so.
- **The `secrets` job scans the full history** (`fetch-depth: 0`, `gitleaks git . -v --redact`) on every PR and push to `main`. The repo is small, so the whole history costs seconds, and a secret added then removed inside one PR is still caught.
- **Job names are short and stable** (`check`, `secrets`), because the ruleset's required status checks match the job name.
- **Ruleset on `main`** (owner's decision, 2026-11-16), applied after the first green push: require a pull request (0 approvals, solo maintainer; merge commit only), require `check` and `secrets` to pass, block force push and deletion, no bypass actors. Repo merge settings match: merge commits on, squash and rebase off, branches not auto-deleted (the portfolio keeps the remote branch).
- **The gate results are recorded through the first PR.** The bootstrap commit can't hold the result of a scan of itself or of its own CI run. The results go into this issue on `chore/FN-00b-gate-record`, and that PR is the first real exercise of the `secrets` job on `pull_request` and of the ruleset.
- **Secret scanning and push protection are enabled before the first push**, so the first push already goes through push protection.

## Files to Create
| File | Purpose |
|------|---------|
| `docs/history/README.md` | Says the two files beside it are the superseded original design |
| `docs/history/byos_storage_google_drive_first_monorepo_skeleton.md` | Moved from the root, content unchanged |
| `docs/history/README_HANDOFF.md` | Moved from the root, content unchanged |

### `docs/history/README.md`
- Three short paragraphs, English, no personal paths or other project names:
  - These two files are the original design handoff for BYOS, kept for the record.
  - `SPECS.md` at the root supersedes them. Where they disagree, `SPECS.md` wins.
  - Their sync design (two-way sync, conflict handling) was cut on purpose: v1 is one-way, append-only backup, and sync is explicitly out of scope. Their full-Drive scopes were also dropped: BYOS requests only `drive.file`/`drive.appdata`.

## Files to Modify
| File | Changes |
|------|---------|
| `.github/workflows/ci.yml` | Rename the `check` job's display name to `check`; add the `secrets` job |
| `issues/FN-00b-git-and-repo.md` | Gate results, on the follow-up branch |
| `issues/_index.md` | Nothing by hand: verify-it flips FN-00b to `done` |

### `.github/workflows/ci.yml`
- In `jobs.check`, change `name: build, lint, typecheck, test` to `name: check`. Leave its steps untouched.
- Add the job:
  - `secrets:` with `name: secrets`, `runs-on: ubuntu-latest`, `timeout-minutes: 5`.
  - Steps:
    1. `actions/checkout@v7` with `fetch-depth: 0` and `persist-credentials: false`.
    2. A `run` step with `GITLEAKS_VERSION: 8.30.1` and `GITLEAKS_SHA256: 551f6fc8…70eb` (full value above) in `env`. The step:
       - downloads `https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz` with `curl -fsSL`;
       - checks it with `echo "${GITLEAKS_SHA256}  <file>" | sha256sum -c -`;
       - extracts `gitleaks` into `$RUNNER_TEMP`;
       - runs `"$RUNNER_TEMP/gitleaks" git . -v --redact`.
  - A comment above the step explains three things: why a pinned binary and not the action (license, PR-comment permission, no third-party runtime with the token); that the checksum is a literal so a replaced release asset fails the job; and that Dependabot doesn't update it, so the version is bumped by hand.
- The workflow-level `permissions: contents: read` stays and covers both jobs.

## Data Requirements
- None.

## Testing Strategy
- No code changes, so no new unit tests. The proof is the gate itself and two CI runs: the bootstrap push to `main`, and the follow-up PR, which must run `secrets` on `pull_request`.
- Before the commit, `pnpm check` (Prettier checks the workflow YAML) must be green.

## Implementation Order
1. **Riskiest first, before any git write: the leak sweep of what will be committed.**
   - Move the two handoff files into `docs/history/` with `mv` (no git yet) and write `docs/history/README.md`.
   - Re-run the gate step 2 grep over every file that will be committed (all files except `node_modules/`, `packages/*/dist/`, `issues/_local/`). The grep looks for:
     - Google credential shapes: a real numeric prefix before `apps.googleusercontent.com`, `GOCSPX-`, `ya29.`, `1//0`, `AIza`;
     - `@gmail` and other personal email addresses;
     - `/Users/`, and `C:\Users\` followed by anything other than the placeholders `me` and `<me>`;
     - names of other private projects or infra.

     A pre-scan on 2026-11-16 found only the placeholders `C:\Users\me` and `C:\Users\<me>`, the generic word "portfolio", and this issue's own rule text. Anything else stops the issue: report it to the owner, and treat a real credential as leaked (rotate it).
   - Confirm gate step 3 by reading `.gitignore`.
2. Edit `.github/workflows/ci.yml` (job rename plus `secrets` job). Run `pnpm check`; it must be green.
3. Set up git locally:
   - `git init -b main`;
   - set the local `user.name`/`user.email` (noreply);
   - stage with explicit paths: `.editorconfig .github .gitignore .nvmrc .prettierignore .prettierrc DISCOVERY.md LICENSE README.md SPECS.md docs eslint.config.mjs issues package.json packages pnpm-lock.yaml pnpm-workspace.yaml tests tsconfig.base.json tsconfig.json vitest.config.ts`.

   Then check all of the following:
   - `git status --short` has no untracked file left that should be committed;
   - `git ls-files | grep -E '(^|/)(node_modules|dist|_local)/'` is empty;
   - `git ls-files -s | awk '$1=="160000"'` is empty.
4. **Owner confirms the commit.** Commit with subject `chore: bootstrap the workspace, spec, plan and green check` and a body of at most two lines, no attribution trailer. Then run `gitleaks git . -v` and `gitleaks dir . -v`; both must say `no leaks found`. Check the author and committer with `git log --format='%an <%ae>|%cn <%ce>'`: both must be the noreply address.
5. **Owner confirms creating the public repo.** Run `gh repo create afonsoamaro/byos --public --description "Bring Your Own Storage: keep an app's user files in the user's own cloud drive. TypeScript library and CLI, Google Drive first." --source . --remote origin` (no `--push`).
6. **Owner confirms the security and merge settings.** Then:
   - `gh api -X PATCH repos/afonsoamaro/byos --input <scratch json>` with the following body (gate step 4 plus the merge settings): `{"security_and_analysis":{"secret_scanning":{"status":"enabled"},"secret_scanning_push_protection":{"status":"enabled"}},"allow_merge_commit":true,"allow_squash_merge":false,"allow_rebase_merge":false,"delete_branch_on_merge":false}`.
   - Verify with `gh api repos/afonsoamaro/byos --jq '.security_and_analysis, .allow_squash_merge, .allow_rebase_merge'`. Both scanning statuses must be `enabled` and both merge flags `false`.
7. **Owner confirms the push.** Run `git push -u origin main`. Watch it with `gh run list --limit 1` and `gh run watch <id> --exit-status`, then read `gh run view <id> --log` for warnings and annotations. Both `check` and `secrets` must be green. If CI is red, fix it on a `fix/` branch through a PR (the ruleset isn't on yet, but the rule still applies).
8. **Owner confirms the ruleset.** Run `gh api -X POST repos/afonsoamaro/byos/rulesets --input <scratch json>` with this body:
   ```json
   {"name":"main","target":"branch","enforcement":"active",
    "conditions":{"ref_name":{"include":["~DEFAULT_BRANCH"],"exclude":[]}},
    "bypass_actors":[],
    "rules":[{"type":"deletion"},{"type":"non_fast_forward"},
     {"type":"pull_request","parameters":{"required_approving_review_count":0,"dismiss_stale_reviews_on_push":false,"require_code_owner_review":false,"require_last_push_approval":false,"required_review_thread_resolution":false,"allowed_merge_methods":["merge"]}},
     {"type":"required_status_checks","parameters":{"strict_required_status_checks_policy":false,"required_status_checks":[{"context":"check","integration_id":15368},{"context":"secrets","integration_id":15368}]}}]}
   ```
   `15368` is the GitHub Actions app id. Verify with `gh api repos/afonsoamaro/byos/rules/branches/main --jq '.[].type'`, which must list the four rule types. Don't test the ruleset with a real direct push to `main`; the follow-up PR exercises it.
9. Record the results on the follow-up branch:
   - `git checkout -b chore/FN-00b-gate-record`.
   - Append an `Execution Record` to this issue: the gate step 1 to 5 outputs, the commit SHA, both CI run ids, and the settings and ruleset checks.
   - **Owner confirms commit, push and PR.** Commit, push, then `gh pr create --base main` with a short body following the PR writing rules, no attribution.
   - Watch the PR's CI. `secrets` must run on the `pull_request` event (that's acceptance criterion 4), and `check` must also be green.
10. Run verify-it for FN-00b on that branch. **Owner confirms the merge.** Then `gh pr merge <n> --merge` (merge commit, branch kept).

## Security Considerations
- The whole issue is a security gate: nothing reaches GitHub before steps 1 and 4 pass, and push protection is on before the first push.
- A finding is treated as leaked: rotate it. Never rewrite history to hide a real secret.
- Commits carry only the noreply address.
- The workflow token stays `contents: read`; the gitleaks binary is checksum-verified; `--redact` keeps any finding's value out of the public CI log.

## Pattern to Copy
- `.github/workflows/ci.yml` from FN-00 for the job shape (`actions/checkout@v7`, `persist-credentials: false`, comments explaining pins).
- The local maintainer note `issues/_local/FN-00-sources.md` (gitignored) for the earlier repos' first-commit shape, if present.

## Verification
- Command:
  ```
  gitleaks git . -v && gitleaks dir . -v && gh api repos/afonsoamaro/byos --jq '.visibility, .security_and_analysis.secret_scanning.status, .security_and_analysis.secret_scanning_push_protection.status' && gh api repos/afonsoamaro/byos/rules/branches/main --jq '[.[].type] | sort | join(",")' && gh run list --branch main --limit 1 --json conclusion --jq '.[0].conclusion'
  ```
  Expected result:
  - `no leaks found` twice;
  - `public`, `enabled`, `enabled`;
  - `deletion,non_fast_forward,pull_request,required_status_checks`;
  - `success`.
- Command: `gh pr checks <follow-up PR number>` lists `check` and `secrets` as pass on the `pull_request` event.
- Manual check: `https://github.com/afonsoamaro/byos` shows the README, `issues/` and `docs/history/`, and no commit shows the personal email (`git log --format=%ae | sort -u` prints only the noreply address).

## Out of Scope
- Any code or package change; FN-01 starts the code.
- Publishing to npm, release tooling, tags: FN-19.
- GitHub Issues or Projects: the issues stay as files in `issues/`.
- Repo topics, social preview image, header image: PP-01.
- Changing the global git config or the email on other repos.
- Rewriting history for any reason short of an owner decision.
- `.gitleaksignore` or a custom gitleaks config, unless a false positive appears (then follow the registry: fingerprint plus reason).

## Checkpoint
- `Checkpoint: sim` after step 6 (security settings before the first push): re-read the `gh api` output and confirm both scanning statuses are `enabled` before step 7.

---

# Execution Record (2026-11-16 to 2026-11-17)

## Security gate (before the first push)
1. `gitleaks git . -v` on commit `3ce53e7` (the whole history): `no leaks found`. `gitleaks dir . -v`: `no leaks found`.
2. Manual grep of the 66 committed files for credential shapes, email addresses, home paths and other project or infra names. The only matches were placeholders (`owner@example.com`, `your.apps.googleusercontent.com`, `your_secret`, `C:\Users\me`) and this issue's own rule text.
3. `.gitignore` covers `.env*` (except `.env.example`), `client_secret*.json`, `*.byos`, `tokens/`, `*.sqlite`, `*.sqlite-*`, `*.db`, `coverage/`, `dist/`, and `issues/_local/`.
4. Repo created public on 2026-11-17. Secret scanning and push protection were enabled before the first push. `gh api repos/afonsoamaro/byos` reported `secret_scanning: enabled`, `secret_scanning_push_protection: enabled`, `allow_squash_merge: false`, `allow_rebase_merge: false`, `allow_merge_commit: true`, `delete_branch_on_merge: false`.
5. The `secrets` job in `.github/workflows/ci.yml` runs gitleaks 8.30.1 from the checksum-verified release binary on every pull request and every push to `main`.

## Commits and CI
- Bootstrap commit `3ce53e7` on `main`. Author and committer are both the GitHub noreply address, set in the local repo config.
- First CI run `44108101164`, a push to `main`: `check` success and `secrets` success. In the `secrets` log, the checksum check printed `OK`, then `1 commits scanned.` and `no leaks found`. The only annotation was a GitHub notice about `ubuntu-latest` moving to Ubuntu 26. No warnings.

## Ruleset
- Ruleset `27482952` (`main`, active). `gh api repos/afonsoamaro/byos/rules/branches/main` lists `deletion,non_fast_forward,pull_request,required_status_checks`, with `allowed_merge_methods: ["merge"]` and required checks `check` and `secrets` (GitHub Actions, `integration_id` 15368).

## Old design handoff
- Moved to `docs/history/` with a `README.md` that says `SPECS.md` supersedes it and that the sync design was cut.
