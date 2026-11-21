# [FN-10] `byos doctor`

## Type
Functional

## Description
The developer onboarding guide in command form: it checks every setup step it can observe and, for each failure, prints the exact Google Cloud console step that fixes it. This is BYOS's answer to the discovery's "onboarding is the product's hardest problem".

## User Flow
1. User runs `byos doctor` before or after `byos auth`.
2. Gets a checklist (pass/warn/fail) and exits non-zero if any check failed.

## Requirements
Checks, in order:
- Client JSON found, parses, type `installed`.
- Drive API reachable with the stored token (`about.get`); a 403 `accessNotConfigured` means the Drive API is not enabled in the project → print the enable step.
- Token present and refreshable.
- Granted scopes are within `drive.file`/`drive.appdata`; extra scopes → warn.
- Token age and the Testing-mode warning: always print a reminder that a consent screen in "Testing" expires refresh tokens 7 days after consent and caps the app at 100 test users, with the fix (publish to production). BYOS cannot read the publishing status through the API, so this is a warning, not a check; say so.
- `--json` output with each check's `{ id, status, message, fix }`.
- Wording follows PP-02. The fix texts double as the README onboarding steps (FN-18).

## Scenarios
### Happy Path
- All checks pass with a valid client and token.
### Edge Cases
- No token yet: checks that need it are `skip` with "run `byos auth`".
### Error Handling
- API disabled, wrong client type, extra scopes, expired grant: each produces its fix text.

## Data Requirements
- None.

## External Dependencies
- Drive `about.get`.

## Acceptance Criteria
- [ ] Each check has a test for pass and for its failure mode, with fake responses.
- [ ] `--json` shape is stable and documented in `docs/cli-output.md`.
- [ ] Exit code is non-zero when any check fails, zero with only warnings.
- [ ] The Testing-mode warning is always shown and explains why it can't be checked.

## Dependencies
- FN-09.

---

# Implementation Plan

## Prerequisites
- FN-09 done: CLI skeleton (`main`, `output.ts`, `errors.ts` with `exitCodeFor`, `config.ts`, `context.ts`, `client-file.ts`), `DriveProvider.account()` (`about.get`), and the CLI test helpers (`packages/cli/test/helpers.ts`: `memoryIO`, temp config dir, fake fetch for Google token and Drive).
- Branch `feat/FN-10-cli-doctor` from an up-to-date `main`. Node 26 in every shell, background ones included.

## Priorities
1. Every failure prints the exact step that fixes it. The fix texts are the onboarding guide (FN-18 copies them).
2. Never claim something BYOS can't observe. The Testing-mode state is a standing warning, not a check.
3. The acceptance criteria.

## Reusable Code Found
- `packages/cli/src/client-file.ts`: loading and validating the Desktop client (type `installed`).
- `packages/cli/src/context.ts`: the store, `TokenManager` and `DriveProvider` for the configured client.
- `packages/drive/src/drive-provider.ts`: `account()` hits `about.get` and is the "Drive API reachable" probe.
- `packages/drive/src/api/errors.ts`: `mapDriveError`. It gets one new row (see below).
- `scripts/cli-output-mock.ts`: the `doctor` scenario text, the source of the human wording.
- `docs/cli-output.md` is **generated** by `node scripts/cli-output-mock.ts --markdown` and guarded by a drift test (`tests/cli-output-mock.test.ts`). To document the `--json` shape, add a `doctor-json` scenario to the mock and regenerate. Never hand-edit the doc.

## Knowledge Registry
- **Absence tests** need a control.
- **Fake `fetch`:** no `as` assertion.
- **Background shells start on Node 24.**

## Architecture Decisions
- **Check model (`packages/cli/src/doctor/checks.ts`):** `type CheckResult = { id: CheckId; status: 'pass' | 'warn' | 'fail' | 'skip'; message: string; fix?: string }`. Checks run in order, and later checks `skip` when they depend on an earlier failure.
  1. `client-file`: configured (or given with `--client`), exists, parses, type `installed`. Fail fixes:
     - no client: "Google Cloud console › APIs & Services › Credentials › Create credentials › OAuth client ID › Desktop app, download the JSON, then run byos auth --client <file>";
     - wrong type: "...create a Desktop app client; Web clients can't use the loopback sign-in".
  2. `token`: a token is stored, and `tokens.getAccessToken()` succeeds, refreshing if needed.
     - No token: `skip` "run byos auth".
     - `AuthError` `testing-mode-expiry-suspected`: `fail` with the publish fix.
     - Other `AuthError`: `fail` "run byos auth".
  3. `drive-api`: `provider.account()` succeeds.
     - A 403 `accessNotConfigured`: `fail` with the fix "Google Cloud console › APIs & Services › Library › Google Drive API › Enable".
     - It is `skip` if `token` didn't pass.
  4. `scopes`: the token's granted scopes are within `drive.file` and `drive.appdata`. Extra scopes give `warn` listing them, with the fix "revoke at myaccount.google.com › Security › Third-party access, then byos auth again"; nothing broader is ever requested by BYOS.
  5. `testing-mode`: **always `warn`**, even when everything else passes.
     - The message: "If your OAuth consent screen is in Testing, Google expires refresh tokens 7 days after consent and limits the app to 100 test users. BYOS can't read the publishing status through the API, so this is a reminder, not a check."
     - The fix: "Google Cloud console › APIs & Services › OAuth consent screen › Publish app".
     - When a token exists, it appends the consent age.
  - The issue lists "Drive API reachable" before "token". The order here is client, token, API, because the API probe needs a token. Recorded as a deviation.
- **New Drive error row:** `packages/drive/src/api/errors.ts` maps a 403 with reason `accessNotConfigured` to `ProviderError('the Google Drive API is not enabled in this Google Cloud project (accessNotConfigured)', { retryable: false })`. Doctor recognizes it by `error instanceof ProviderError && error.message.includes('accessNotConfigured')`. Both the wording and the test live in the drive package.
- **Fix texts as constants (`packages/cli/src/doctor/fixes.ts`):** `FIXES` is an `as const` record keyed by check and failure. FN-18's `docs/google-cloud-setup.md` uses the same strings, and a test there can compare them.
- **Exit code:**
  - 0 when there is no `fail` (warnings and skips are fine);
  - otherwise 5 when the failing check is `token` or `client-file` (auth setup), else 1;
  - this matches the PP-02 doc row "5 AUTH_FAILED (doctor: a failing auth check)".
- **Output:**
  - human: one line per check with the symbol, an indented `fix:` line for each non-pass with a fix, and a final `n failed, n warnings`, following the PP-02 `doctor` scenario;
  - `--json`: `{ ok: boolean, checks: CheckResult[] }` on stdout, with no other output.
- **`docs/cli-output.md`:** add a `doctor-json` scenario to `scripts/cli-output-mock.ts` with that shape, regenerate the doc with `node scripts/cli-output-mock.ts --markdown > docs/cli-output.md`, and keep the drift test green.

## Files to Create
| File | Purpose |
|------|---------|
| `packages/cli/src/doctor/checks.ts` | The five checks and the runner |
| `packages/cli/src/doctor/fixes.ts` | Fix texts as constants |
| `packages/cli/src/commands/doctor.ts` | `byos doctor [--client <file>] [--json]` |
| `packages/cli/test/doctor.test.ts` | Pass and failure per check, skip chain, exit codes, `--json` shape |

## Files to Modify
| File | Changes |
|------|---------|
| `packages/cli/src/program.ts` | Register `doctor` |
| `packages/drive/src/api/errors.ts` | The `accessNotConfigured` row, plus a test in `packages/drive/test/drive/errors.test.ts` |
| `scripts/cli-output-mock.ts` | Scenario `doctor-json` |
| `docs/cli-output.md` | Regenerated |
| `issues/FN-10-cli-doctor.md` | Execution Record |
| `issues/_index.md` | FN-10 `todo` → `planned` now; `done` only by verify-it |

## Data Requirements
- None.

## Testing Strategy
- `doctor.test.ts` runs through `main(['doctor', ...], memoryIO())` with the FN-09 helpers:
  - all pass: exit 0, 4 passes plus the testing-mode warn;
  - no client configured: `client-file` fails, the others skip, exit 5;
  - a Web client JSON: fail with the Desktop fix;
  - no token: `token` skip with "run byos auth", `drive-api` skip, exit 0 (only warns and skips);
  - refresh `invalid_grant` 7 days after consent: `token` fails with the publish fix, exit 5;
  - Drive `about` answers 403 `accessNotConfigured`: `drive-api` fails with the enable fix, exit 1;
  - token scopes include `drive`: `scopes` warns, exit 0;
  - the testing-mode warning is present in every run (every case above asserts it);
  - `--json` parses as `{ ok, checks }`, with ids in order and nothing else on stdout.
- In the drive errors test: 403 `accessNotConfigured` gives the new message, with no retry.
- The drift test (`tests/cli-output-mock.test.ts`) stays green after regenerating the doc.

## Implementation Order
1. **Riskiest first, the token and API probe interplay.** Write the `token` and `drive-api` checks with the skip chain and their tests (the `invalid_grant` age path and `accessNotConfigured`).
2. Write the `client-file`, `scopes` and `testing-mode` checks, `fixes.ts`, the command and the output.
3. Update the mock scenario and regenerate the doc.
4. `pnpm format`, then `pnpm check`.

## Security Considerations
- Doctor prints no token and no client secret; it reports only check status and fix steps.
- Network calls go only through the existing provider (Google endpoints).

## Pattern to Copy
- `packages/cli/src/commands/auth.ts` (FN-09) for command structure and output.
- `scripts/cli-output-mock.ts` `doctor` scenario for wording.

## Verification
- Command: `pnpm check` (green, including `doctor.test.ts`, the new drive error case and the CLI output drift test).
- Done when: the check is green. The delivery carries the check counts and the verify-it report.

## Out of Scope
- Reading the consent screen's publishing status (no API for it).
- Writing the onboarding docs (FN-18).

## Checkpoint
- `Checkpoint: nao`
