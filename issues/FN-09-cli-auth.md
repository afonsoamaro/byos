# [FN-09] `byos auth`: loopback OAuth, status and logout

## Type
Functional

Checkpoint: sim (security: OAuth redirect handling)

## Description
The user connects their Google account from the terminal: the CLI opens the browser, receives the redirect on a local loopback port, exchanges the code and stores the token.

## User Flow
1. User runs `byos auth --client ./client_secret.json` (path saved in CLI config for later runs).
2. CLI starts an HTTP server on `127.0.0.1` with a random free port, opens the browser at the authorization URL (and prints it, for when no browser opens).
3. User consents; Google redirects to `http://127.0.0.1:<port>/callback?code=...&state=...`.
4. CLI checks `state`, exchanges the code (FN-03), saves the token (FN-08), shows a "you can close this tab" page, prints the connected account and scopes, and shuts the server down.
5. `byos auth status` prints account, scopes, consent date and token age, with the Testing-mode warning when older than 6 days. `byos auth logout` revokes and clears.

## Requirements
- Client JSON validated with Zod: must be type `installed` (Desktop). Web or other types fail with an explanation that points at `byos doctor`.
- Loopback server binds to `127.0.0.1` only, accepts exactly one valid callback, rejects mismatched `state` (shows an error page and keeps waiting until timeout), times out after 5 minutes.
- Account email from a userinfo-free source: Drive `about.get` with `fields=user(emailAddress,displayName)`, so no extra scope is needed.
- Output wording follows PP-02.
- **Security**: the code and tokens are never printed; the callback page contains no token; the server never binds to `0.0.0.0`.

## Scenarios
### Happy Path
- Full flow against a fake token endpoint and a simulated browser hitting the callback.
### Edge Cases
- No browser available (headless/SSH): the printed URL is enough; the flow still completes when the user opens it elsewhere on the same machine.
- User denies consent (`error=access_denied`): clean message, non-zero exit.
### Error Handling
- Port already in use is impossible by design (random free port); timeout gives a clear message.
- `state` mismatch is rejected.

## Data Requirements
- CLI config file (client JSON path) in the config directory.

## External Dependencies
- Google OAuth endpoints, Drive `about.get`; `open`-style browser launch (pick the smallest maintained package or `start`/`open`/`xdg-open` via `child_process`).

## Acceptance Criteria
- [ ] Loopback flow completes in an automated test with a fake token endpoint.
- [ ] Server binds to `127.0.0.1`, rejects bad `state`, times out.
- [ ] Non-Desktop client JSON is rejected with a pointer to `doctor`.
- [ ] `auth status` shows account, scopes, consent date and the >6-day warning.
- [ ] `auth logout` revokes and clears the store.
- [ ] Manual run against the owner's real Google project succeeds (owner step, recorded here).

## Dependencies
- FN-03, FN-04, FN-08, PP-02.
