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
