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

---

# Implementation Plan

## Prerequisites
- FN-09 and FN-11 done:
  - `byos auth`, `byos put`, `stat`, `ls` and `--json`, with `--config-dir` to keep separate sign-ins side by side;
  - `@byos/drive` exports `createAuthRequest`, `exchangeCode`, `TokenManager` and `DriveProvider` (`stat`, `list`, `account`).
- **Owner steps in Google Cloud** (the agent writes the checklist; the owner clicks):
  - In the owner's existing BYOS project, which already has the Desktop client from FN-09, create a **Web application** client. Its authorized redirect URI is `http://127.0.0.1:53682/callback`. Download its JSON **outside the repo**.
  - Create a **separate Cloud project** with the Drive API enabled, an External consent screen with `drive.file`, and a Desktop client (the control). Download its JSON outside the repo.
  - Both projects stay in Testing with the owner as a test user (7-day expiry is irrelevant for a one-day spike).
- Branch `chore/FN-15-spike` from an up-to-date `main`. Node 26 in every shell, background ones included.

## Priorities
1. Answer the question with evidence (status codes and observed visibility), no tokens or client secrets anywhere in the repo.
2. Write the verdict back into `SPECS.md` (Open Question 1), resolved or redesigned.
3. Keep the spike throwaway: no production code changes.

## Reusable Code Found
- The CLI covers the Desktop side end to end. Each client gets its own `--config-dir` (a temp folder outside the repo): `byos --config-dir <dir> auth --client <json>`, then `put`, `stat id:<id> --json` and `ls --json`.
- `@byos/drive` (`createAuthRequest`, `exchangeCode`, `TokenManager`, `DriveProvider`) drives the Web client side, which the CLI refuses by design (Desktop only).
- `packages/cli/src/store/file-token-store.ts` can hold the Web client's token in its own config dir.

## Knowledge Registry
- **Background shells start on Node 24.**
- A URL or credential that comes back from outside never goes into a log. The spike prints only status codes, ids and names.

## Architecture Decisions
- **Script `scripts/spikes/cross-client-visibility.ts`**, run with `node scripts/spikes/cross-client-visibility.ts <command>`:
  - `auth-web --client <web.json> --config-dir <dir>`:
    - a loopback on the **fixed** port 53682 (Web clients need a registered redirect URI);
    - `createAuthRequest` with `drive.file`, open or print the URL, then `exchangeCode` with the client secret from the JSON (`web` key);
    - save with `FileTokenStore`, imported from the built CLI package's `dist`, or reimplemented minimally in the script if the export isn't public; the decision is made at execution and recorded.
  - `probe --client <json> --config-dir <dir> --id <fileId> --name <name>` builds a `TokenManager` and `DriveProvider` for that client and runs:
    - `stat({ id })`;
    - `list({ parent: { id: <parentId> } })`, looking for the file;
    - a name query through `stat({ path })`.
    - It prints a JSON line `{ client, statById: 'found' | 'not-found' | 'error:<code>', listedInParent: boolean, byPath: ... }`, with no tokens and no URLs.
  - Credentials are read only from the paths given on the command line. The script contains no secrets, and `.gitignore` already covers `client_secret*.json` and `tokens/`.
- **Protocol** (the owner runs it with the agent reading the outputs back):
  1. Desktop client A (project P): `byos auth`, then `byos put` a small file into `Spike/` and note its id with `--json`.
  2. Web client B (project P): `auth-web`, then `probe` A's file id.
  3. **Reverse direction:** client B uploads its own file (add `upload` to the script, or use `DriveProvider.put` inside `probe --upload`), then client A runs `byos stat id:<id> --json` and `byos ls Spike --json`.
  4. **Control:** a Desktop client in project Q (`byos auth` in a third config dir), then `stat` and `ls` of both files must be not-found.
- **Verdict rules:**
  - visible both ways within P and invisible from Q: the hypothesis holds;
  - visible by id but not listed: record it, because it changes the mobile browse design;
  - any `PermissionError` or 404 within P: the hypothesis is false. Stop and write a redesign note (Google Picker or app-data sharing) into `SPECS.md` before the mobile spec.
- **Results:**
  - recorded in this issue: dates, client types, and per step the status and visibility, with no ids of real files beyond a short prefix and no tokens;
  - `SPECS.md` Open Question 1 is rewritten as resolved, with the date and a one-paragraph verdict, or as redesigned.

## Files to Create
| File | Purpose |
|------|---------|
| `scripts/spikes/cross-client-visibility.ts` | Throwaway spike: Web client auth and visibility probes |
| `docs/spikes/cross-client-visibility-checklist.md` | The owner's click-by-click checklist and the command sequence, written before the run |

## Files to Modify
| File | Changes |
|------|---------|
| `SPECS.md` | Open Question 1: verdict with date |
| `issues/FN-15-spike-cross-client-visibility.md` | Results table and verdict |
| `issues/_index.md` | FN-15 `todo` → `planned` now; `done` only by verify-it after the owner's run |

No production package changes. If the spike needs a library export that doesn't exist, it reimplements the minimum locally instead of changing a package, and notes it.

## Data Requirements
- None. Real files are created only under `Spike/` in the owner's Drive and are deleted after the run (by the owner, trash is fine).

## Testing Strategy
- The script is type-checked and linted by `pnpm check`, since the root `tsconfig.json` already includes `scripts/`. It has no unit tests: it is a manual spike, and the evidence is the recorded run.
- Before handing it to the owner, run `node scripts/spikes/cross-client-visibility.ts --help` to check it starts and lists its commands.

## Implementation Order
1. Write the checklist doc, so the owner can create the clients while the script is being written.
2. Write the script (`auth-web`, `probe`, `upload`) and `pnpm check`.
3. **Owner run** following the checklist; the agent reads the JSON lines back.
4. Record the results and verdict in this issue, update `SPECS.md`, then `pnpm check`.

## Security Considerations
- No client JSON, token or secret is committed. The script takes them as file paths outside the repo, and prints none of them.
- The Web client's fixed loopback binds `127.0.0.1` only, like the CLI's.
- After the run, the owner can delete the Web client and the control project.

## Pattern to Copy
- `packages/cli/src/auth/loopback.ts` (FN-09) for the callback server, with a fixed port here.
- `scripts/cli-output-mock.ts` for a runnable `.ts` script with hand-parsed arguments.

## Verification
- Command: `pnpm check` (green with the script included).
- Manual: the owner's run, recorded as a results table in this issue.
- Done when: both directions and the control are recorded, the verdict is in `SPECS.md`, and the check is green. The delivery carries the results table and the check counts.

## Out of Scope
- An iOS or Android client run (needs the mobile app); the Web client stands in for "a different client type in the same project".
- Any change to `@byos/core`, `@byos/drive` or `@byos/cli`.

## Checkpoint
- `Checkpoint: nao`
