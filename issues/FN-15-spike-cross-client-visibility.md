# [FN-15] Spike: file visibility across OAuth clients under `drive.file`

## Type
Functional (validation spike)

## Description
SPECS open question 1. The future mobile app and the CLI will use different OAuth clients (iOS/Android vs Desktop) in the same Google Cloud project. The design assumes `drive.file` access belongs to the project, so files the CLI uploaded are visible to the mobile app. If that's false, cross-device browsing needs Google Picker or another design. Validate it before the mobile spec is written.

## User Flow
1. In the owner's project, create a second OAuth client of a different type (Web or iOS) next to the Desktop client.
2. Upload a file with the CLI (Desktop client).
3. Authorize the second client with the same Google account and `drive.file`, then `files.get` and `files.list` the file by ID.
4. Repeat in the other direction.
5. Create a separate Cloud project with its own client and confirm it can NOT see the files (control).

## Requirements
- A throwaway script under `scripts/spikes/` using `@byos/drive` with the second client's credentials.
- Results recorded here with dates and exact API responses (status codes, no tokens).
- Conclusion written back into `SPECS.md` Open Questions (resolved or redesigned).

## Scenarios
### Happy Path
- Same project, different client: file visible both ways; other project: not visible.
### Edge Cases
- Visible by ID but not by `list` query: record it, it changes the mobile design.
### Error Handling
- `PermissionError`/404 for the same project means the hypothesis is false: stop and redesign before the mobile spec.

## Data Requirements
- None.

## External Dependencies
- Owner's Google Cloud project; a second OAuth client (owner action).

## Acceptance Criteria
- [ ] Both directions tested with the same project, plus the other-project control.
- [ ] Results and verdict recorded here.
- [ ] `SPECS.md` updated with the outcome.
- [ ] Spike script committed under `scripts/spikes/` with no credentials.

## Dependencies
- FN-09, FN-11.
