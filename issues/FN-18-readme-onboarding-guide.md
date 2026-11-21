# [FN-18] README and developer onboarding guide

## Type
Functional (documentation)

## Description
The README is where a stranger decides whether BYOS is worth 15 minutes. It has to explain the user-owned-storage idea, why BYOS only asks for `drive.file`, and walk Google Cloud setup step by step, with the same fix texts `byos doctor` prints. Also resolves SPECS open question 4.

## User Flow
1. A developer lands on the repo, reads what BYOS is and isn't (no sync), follows the setup guide, runs `byos doctor` and `byos auth`, and backs up a folder.

## Requirements
- README sections: header image (PP-01), what it is, status, what it deliberately doesn't do (sync, full-Drive access), quickstart, packages, library usage example (`DriveProvider` + `TokenStore`), CLI reference link, contributing, license.
- `docs/google-cloud-setup.md`: create project, enable Drive API, External consent screen with `drive.file`, Desktop client, publish to production; screenshots optional; same wording as `doctor` fixes.
- Verify and document open question 4: what an app published to production with only non-sensitive scopes and no brand verification shows to users (unverified-app screen or not, user cap). Record sources and date.
- Explain the `drive.file` visibility limit (files added through the Drive website are invisible to BYOS) and why it's worth it (no security assessment).
- Public-repo rule: no personal paths, private infra or other project names.

## Scenarios
### Happy Path
- Someone following only the README reaches a working backup.
### Edge Cases
- Testing-mode trap documented prominently.
### Error Handling
- Troubleshooting section maps each `doctor` failure to its fix.

## Data Requirements
- None.

## External Dependencies
- Google Cloud documentation (cited).

## Acceptance Criteria
- [ ] README and `docs/google-cloud-setup.md` written.
- [ ] Open question 4 answered with sources and recorded in SPECS.
- [ ] A dry read-through following only the docs on a fresh Google project succeeds (owner step, recorded).
- [ ] No private references in committed text (grep check recorded).

## Dependencies
- PP-01, FN-10.

---

# Implementation Plan

## Prerequisites
- PP-01 done: `docs/header.png` and `docs/logo.svg`; the README's first line already shows the header.
- FN-10 done: `byos doctor`, with the fix texts as constants in `packages/cli/src/doctor/fixes.ts`.
- FN-17 done: `docs/server-usage.md`. FN-16 is recommended, so the README's claims match a real run.
- Branch `docs/FN-18-readme` from an up-to-date `main`.

## Priorities
1. A stranger following only the docs reaches a working backup, with no private references anywhere (public repo).
2. The onboarding steps and `byos doctor` say the same thing, enforced by a test.
3. Open Question 4 answered with sources.

## Reusable Code Found
- `README.md`: the current stub (header, what it is, status, what it won't do, development).
- `packages/cli/src/doctor/fixes.ts`: the canonical Google Cloud console steps.
- `docs/cli-output.md`: the CLI reference (generated), linked rather than duplicated.
- `docs/server-usage.md` (FN-17): linked from the README.
- `SPECS.md`: Goals, Scope, "What it won't do", the onboarding section, and Open Question 4.

## Knowledge Registry
- **README header:** 1200×630, already produced in PP-01; the first line stays as is.
- **Public repo:** describe the pattern, never the origin. No private paths, infrastructure or other project names, which the grep check enforces.

## Architecture Decisions
- **README sections**, in order:
  - the header image;
  - what it is (2 to 3 sentences);
  - status (alpha, what works);
  - what it deliberately doesn't do (no sync; `drive.file` only, so files added through the Drive website are invisible to BYOS, and that is the price of not needing a security assessment);
  - quickstart (install, `byos doctor`, `byos auth`, `byos backup <folder> --dry-run`, then a real run);
  - packages (`@<scope>/core`, `drive`, `cli`, one line each; the scope is filled in by FN-19, so use a placeholder sentence "published under the maintainer's npm scope, see Releases");
  - library usage (a short `DriveProvider` + `TokenManager` + `TokenStore` example, which type-checks, see below);
  - the CLI reference (link to `docs/cli-output.md`);
  - servers (link to `docs/server-usage.md`);
  - contributing (`pnpm install`, `pnpm check`, issues flow);
  - license.
- **`docs/google-cloud-setup.md`:**
  - create a project, enable the Drive API, set up an External consent screen with the `drive.file` scope, create a Desktop app client, download the JSON, **publish the app to production** (the Testing trap: a 7-day token expiry and 100 test users, shown prominently), and optionally a "TVs and Limited Input devices" client for servers;
  - **each step's wording is the matching `FIXES` constant**: a test (`packages/cli/test/docs-sync.test.ts`) reads the doc and asserts every `FIXES` string appears in it, so changing one without the other fails the check;
  - screenshots are optional and left out.
- **Troubleshooting section** (in the setup doc): one entry per `doctor` failure id (`client-file`, `token`, `drive-api`, `scopes`, `testing-mode`), with the same fix text.
- **Open Question 4** ("non-sensitive-scope app in production without brand verification: unverified-app screen? user cap?"):
  - at execution, read Google's current pages: the OAuth consent screen "Publishing status" and "Unverified apps" help, and the "OAuth app verification" help center, through the web-fetch agent;
  - record the answer with URLs and the read date in this issue and in `SPECS.md` (resolved);
  - the README states the outcome in one sentence.
- **The library example compiles:** the snippet in the README is copied from `packages/drive/test/readme-example.test.ts`, which imports from the package entry points and runs against the fake `fetch` (the drive test helpers). A text-equality check isn't needed; the test keeps the API usage valid, and the README notes "(from test/readme-example.test.ts)".
- **Private-reference grep check:** at delivery, run `git grep -n -i -E "/Users/|\\.claude|infra/|portf" -- README.md docs SPECS.md issues ':!issues/_local'` and record the output. It must find nothing that names a private path, private infrastructure or another project. `docs/history/` is excluded only if it was already reviewed at FN-00b; check it too and record.
- **Owner dry read-through:** on a fresh Google account or project, follow only the README and the setup doc up to a successful `byos backup --dry-run` and a small real backup. Record the date and every place the docs were unclear (each fixed here, or turned into an issue).

## Files to Create
| File | Purpose |
|------|---------|
| `docs/google-cloud-setup.md` | Setup guide and troubleshooting |
| `packages/cli/test/docs-sync.test.ts` | Every `FIXES` string appears in the setup doc |
| `packages/drive/test/readme-example.test.ts` | The README library example, executed against fakes |

## Files to Modify
| File | Changes |
|------|---------|
| `README.md` | Full README per the sections above (keep line 1) |
| `SPECS.md` | Open Question 4 resolved with sources |
| `issues/FN-18-readme-onboarding-guide.md` | Open Question 4 sources, grep output, the owner's read-through record |
| `issues/_index.md` | FN-18 `todo` → `planned` now; `done` only by verify-it |

## Data Requirements
- None.

## Testing Strategy
- `docs-sync.test.ts` and `readme-example.test.ts` run in `pnpm check`.
- The grep check is recorded.
- The owner's read-through is recorded.

## Implementation Order
1. Write the setup doc from `FIXES`, then `docs-sync.test.ts`. This is the only part that can drift silently.
2. Research and record Open Question 4.
3. Write the README, with the example test.
4. Run the grep check, then `pnpm check`.
5. The owner's read-through, with fixes from it.

## Security Considerations
- The docs tell users to keep client JSON and export files out of repos and to delete exports after import. No real secrets or personal paths appear in examples (placeholders only).

## Pattern to Copy
- `docs/server-usage.md` (FN-17) for doc tone.
- `tests/cli-output-mock.test.ts` for a doc-drift test.

## Verification
- Command: `pnpm check` (green, with the two new tests).
- Command: the grep above (no private matches, output recorded).
- Manual: the owner's read-through recorded.
- Done when: all three hold and Open Question 4 is recorded with sources. The delivery carries the grep output, the sources and the check counts.

## Out of Scope
- A docs website, translations (English only), and screenshots.

## Checkpoint
- `Checkpoint: nao`
