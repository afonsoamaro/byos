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
