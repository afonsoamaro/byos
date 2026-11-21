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

---

# Implementation Plan

## Prerequisites
- FN-03, FN-04 and FN-08 done:
  - `createAuthRequest`, `exchangeCode`, `mergeReconnect`, `revokeToken` and `TokenManager` in `@byos/drive`;
  - `DriveProvider`, `DriveClient` (`json`), `filesUrl` and `FILE_FIELDS`;
  - `FileTokenStore`, `configDir` and `writeFileAtomic` in `packages/cli/src/store/`.
- PP-02 done: `docs/cli-output.md` is the wording and conventions reference. `scripts/cli-output-mock.ts` holds the exact strings for `auth` and `auth status`.
- Add `zod` `4.6.7` to `packages/cli` `dependencies`, exact: `pnpm --filter @byos/cli add zod@4.6.7 --save-exact`. It is the same pin as `@byos/drive`. Stage `pnpm-lock.yaml`.
- Branch `feat/FN-09-cli-auth` from an up-to-date `main`. Node 26 in every shell, background ones included.

## Priorities
1. No token, code or verifier on screen, in the callback page or in an error. The loopback server never binds beyond `127.0.0.1`.
2. Lay the CLI structure (`main`, output, errors, context) that FN-10 to FN-14 reuse, so it is decided once.
3. The acceptance criteria.

## Reusable Code Found
- `packages/cli/src/program.ts` (`createProgram`, commander, version from `package.json`) and `packages/cli/src/bin.ts`.
- `scripts/cli-output-mock.ts`: the PP-02 output rules to port into real code, not import:
  - `supportsUnicode()`, the `UNICODE` and `ASCII` symbol sets, and `paint(format, text, sink)` with `util.styleText(..., { stream })`;
  - the `auth` and `auth-status` texts, and the exit-code table.
- `packages/drive/src/oauth/*`: the whole OAuth client side.
- `packages/drive/src/api/client.ts`: `DriveClient` (a DriveProvider-private client). The `about.get` call goes through the provider (see below).
- `packages/cli/src/store/*` (FN-08).

## Knowledge Registry
- **CLI color:** `util.styleText(format, text, { stream })` drops color on its own when the stream is not a TTY or `NO_COLOR` is set, and forces it with `FORCE_COLOR`. No chalk.
- **Spawning one process per test case** times out under load. Run commands in-process through `main()` and keep spawned-process tests to a minimum, run once in a `beforeAll`.
- **Fake `fetch`:** no `as` assertion. **Absence tests** need a control. **Background shells start on Node 24.**

## Architecture Decisions
- **CLI skeleton**, built here and reused by every later command:
  - `packages/cli/src/main.ts`: `main(argv: string[], io: CliIO): Promise<number>` returns the exit code.
    - `CliIO` is `{ stdout: NodeJS.WriteStream | Sink; stderr: ...; env: NodeJS.ProcessEnv; platform: NodeJS.Platform; homedir: string; fetch: typeof fetch; openBrowser: (url: string) => Promise<boolean>; now: () => number }`.
    - `bin.ts` becomes `process.exitCode = await main(process.argv.slice(2), realIO())`.
    - Tests call `main` with fakes, so no network, browser or real config dir is touched.
  - `packages/cli/src/program.ts`: `createProgram(io, state)` builds the commander tree.
    - Global options: `--config-dir <dir>` and `--json`.
    - `exitOverride()` plus `configureOutput` turn commander usage errors into exit code `2`, printed through the output module.
    - `--version` keeps working, and the existing `program.test.ts` still passes, adapted to the new signature.
  - `packages/cli/src/output.ts` ports the PP-02 rules:
    - `createOutput(io, { json })` returns `{ ok(text), warn(text), fail(text), step(text), line(text), data(value) }`;
    - human lines go to stdout, warnings and errors to stderr, with symbols and the fallback;
    - under `--json` only `data(value)` writes, a single JSON document to stdout, and errors print one `{ code, message }` to stderr.
  - `packages/cli/src/errors.ts`:
    - `CliError(message, exitCode)` covers CLI-level failures (consent denied, timeout, bad client file);
    - `exitCodeFor(error)` follows the PP-02 and FN-11 table: 2 usage, 3 not found, 4 conflict, 5 auth, 6 quota, 7 rate limited, 1 anything else, plus `CliError.exitCode`;
    - `report(out, error)` prints the human or JSON error and never prints `cause` or `stack`.
  - `packages/cli/src/config.ts`: the CLI config at `<configDir>/config.json`, `{ clientFile?: string; account?: { email: string; displayName?: string }; tokenKey: 'default' }`, written with `writeFileAtomic` (mode 0600).
  - `packages/cli/src/context.ts`: `openContext(io, flags)` returns `{ out, configDir, config, store: FileTokenStore, client: InstalledClient, tokens: TokenManager, provider: DriveProvider }`. It is built lazily, so `auth` can run before a token exists. FN-10 and FN-11 reuse it.
- **Client file (`packages/cli/src/client-file.ts`):**
  - a zod schema for Google's download: `{ installed: { client_id: string, client_secret?: string, auth_uri?, token_uri?, redirect_uris? } }`;
  - any other top-level key (`web`, ...) or a missing `installed` throws `CliError('this client file is not a Desktop app client (type <kind>). Create an OAuth client of type "Desktop app"; byos doctor explains the steps.', 5)`;
  - a missing or unparsable file gives `CliError` exit 2;
  - `--client` is resolved to an absolute path and saved in the config for later runs.
- **Loopback (`packages/cli/src/auth/loopback.ts`):** `startLoopback({ timeoutMs }): Promise<{ redirectUri, expect(state): Promise<string>, close() }>`.
  - It runs `http.createServer` and `listen(0, '127.0.0.1')`, so the port is random and free. The `redirectUri` is `http://127.0.0.1:<port>/callback`.
  - Only `GET /callback` is handled; anything else gives a 404.
  - `error=access_denied` (or any `error`) rejects with `CliError('Google sign-in was cancelled', 5)` and serves a short "sign-in cancelled" page.
  - **A `state` mismatch** gives a 400 page "this sign-in link doesn't match; start again from the terminal", and **keeps waiting**.
  - A valid `code` serves a 200 "you can close this tab" page, resolves the `code` once, and later requests get 410.
  - After `timeoutMs` (default 5 minutes) it rejects with `CliError('timed out waiting for Google sign-in (5 minutes)', 5)`. The server closes in every outcome.
  - Pages are static HTML with no request data echoed back (no code, no state).
- **Opening the browser (`packages/cli/src/auth/open-browser.ts`):** `spawn` detached, with `stdio: 'ignore'`, no shell, and the URL as an argument.
  - Windows: `rundll32 url.dll,FileProtocolHandler <url>`, which avoids `cmd`'s `&` parsing.
  - macOS: `open <url>`.
  - Linux: `xdg-open <url>`.
  - It resolves `false` on spawn error. The URL is always printed anyway (PP-02).
- **Account (`about.get`):** a new public `DriveProvider.account(): Promise<{ email: string; displayName?: string }>`, Drive-specific like `resumeUpload`.
  - It sends `GET https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName)` through the provider's `DriveClient.json`, with a zod schema, in a new `packages/drive/src/api/about.ts`.
  - It needs no extra scope (`drive.file` is enough). `[assumed]` until FN-09's manual run.
- **`byos auth [--client <file>]`:**
  1. Load the client and `startLoopback({ timeoutMs })`, which listens and returns `{ redirectUri, expect(state), close }`. Then call `createAuthRequest({ clientId, redirectUri, forceConsent })`, and finally `loopback.expect(request.state)`. That arms the state check and returns the promise of the code. A callback that arrives before `expect` is armed gets a 400 and does not count.
  2. Print the PP-02 lines, `openBrowser(url)`, and await the code.
  3. `exchangeCode({ clientId, clientSecret, code, codeVerifier, redirectUri, fetch: io.fetch })`, then `mergeReconnect(await store.load(key), fresh)`, then `store.save`.
  4. `provider.account()`, save it to the config, and print `✓ Connected as <email>` with `scopes` from the token (scopes shortened to `drive.file` and `drive.appdata` for display).
  - `forceConsent`: `true` when no token is stored, `false` otherwise.
- **`byos auth status [--json]`:** it reads the token and config with no network.
  - It prints the PP-02 rows: account, scopes, `consented <date> (<n> days ago)`, and token refreshed or expiry.
  - When `now - consentedAt > 6 days` it adds the Testing-mode warning (PP-02 text) on stderr.
  - With no token, it prints `not signed in; run byos auth` and exits 5.
  - `--json` gives `{ account, scopes, consentedAt, expiresAt, testingModeWarning: boolean }`.
- **`byos auth logout`:** `revokeToken({ token: refreshToken ?? accessToken, fetch })`. On failure it prints a warning ("couldn't revoke at Google; the local sign-in is removed anyway") and continues. Then `store.clear` and the account is removed from the config. Exit 0.

## Files to Create
| File | Purpose |
|------|---------|
| `packages/cli/src/main.ts` | `main(argv, io)` and `realIO()` |
| `packages/cli/src/output.ts` | PP-02 output (streams, symbols, color, `--json`) |
| `packages/cli/src/errors.ts` | `CliError`, `exitCodeFor`, `report` |
| `packages/cli/src/config.ts` | CLI config read and write |
| `packages/cli/src/context.ts` | `openContext` (store, client, tokens, provider) |
| `packages/cli/src/client-file.ts` | Desktop client JSON schema and loader |
| `packages/cli/src/auth/loopback.ts` | 127.0.0.1 callback server |
| `packages/cli/src/auth/open-browser.ts` | Platform browser opener |
| `packages/cli/src/commands/auth.ts` | `auth`, `auth status`, `auth logout` |
| `packages/drive/src/api/about.ts` | `about.get` schema and call |
| `packages/cli/test/auth.test.ts` | Full flow in-process with fake Google and fake Drive, plus status and logout |
| `packages/cli/test/loopback.test.ts` | Bind address, bad state, denial, timeout, single use, no echo |
| `packages/cli/test/output.test.ts` | Streams, `--json`, no color when not a TTY, exit-code mapping |
| `packages/cli/test/helpers.ts` | `memoryIO()` capturing stdout and stderr, temp config dir, fake fetch routing Google token, revoke and Drive about |

## Files to Modify
| File | Changes |
|------|---------|
| `packages/cli/src/program.ts` | `createProgram(io, state)` with global options and the `auth` command group |
| `packages/cli/src/bin.ts` | Call `main` and set `process.exitCode` |
| `packages/cli/test/program.test.ts` | Adapt to the new `createProgram` signature |
| `packages/cli/package.json` | `zod` dependency |
| `packages/drive/src/drive-provider.ts` | `account()` |
| `packages/drive/src/index.ts` | Export the account type |
| `pnpm-lock.yaml` | Install |
| `issues/FN-09-cli-auth.md` | Execution Record and the owner's manual run |

## Data Requirements
- `<configDir>/config.json`: `{ clientFile, account, tokenKey }` (0600).

## Testing Strategy
- `helpers.ts`:
  - `memoryIO()` gives non-TTY sinks that collect text, `env: { BYOS_CONFIG_DIR: tmp }`, a `platform`, `openBrowser` set to a simulated browser, and `fetch` routing:
    - `oauth2.googleapis.com/token` and `/revoke` to a scripted fake (reuse the shape of `packages/drive/test/oauth/fake-google.ts`, copied, since cross-package test imports are avoided);
    - `www.googleapis.com/drive/v3/about` to a JSON reply.
  - Writes a Desktop client JSON fixture to the temp dir.
  - The global `fetch` is locked with `vi.stubGlobal`.
- `auth.test.ts`:
  1. **Full flow:** the simulated browser reads `redirect_uri` and `state` from the URL and requests `<redirect_uri>?code=CODE-secret&state=<state>` with the real `fetch` (to the real loopback). Exit 0; stdout has `Connected as owner@example.com`; the token file exists; config has the account.
  2. `forceConsent`: `prompt=consent` on the first run, absent when a token already exists.
  3. A web client JSON gives exit 5 with the doctor pointer; a missing file gives exit 2.
  4. Status prints the rows; with `consentedAt` 7 days old the warning appears on stderr; `--json` has the shape above; not signed in gives exit 5.
  5. Logout calls revoke with the refresh token and clears the store and account; a revoke 400 still clears and warns, with exit 0.
  6. **Leak:** across tests 1–5, the captured stdout and stderr and any served page contain none of `CODE-secret`, the verifier, the access or refresh token, or the client secret. Control: the token file decrypts to the expected token.
- `loopback.test.ts`:
  - `server.address().address === '127.0.0.1'`;
  - a bad `state` gives 400, then a good one succeeds;
  - `error=access_denied` rejects with exit 5;
  - the timeout (set to 50 ms) rejects;
  - a second valid callback gives 410;
  - no response body contains `code=` or the state value.
- `output.test.ts`:
  - human lines go to the right stream;
  - `--json` gives one document on stdout and `{ code, message }` on stderr;
  - no escape codes on non-TTY sinks;
  - `exitCodeFor` covers every row of the table, plus `CliError`.
- **Spawned smoke**, one `beforeAll` running both: `node packages/cli/dist/bin.js --version` exits 0 and prints the version; an unknown command exits 2.
- **Owner manual step** (recorded in the Execution Record, not part of the gate):
  - create a Desktop client in the owner's Google Cloud project (the FN-10/FN-18 steps), then run `byos auth --client <file>`, `byos auth status` and `byos auth logout` against real Google;
  - record the dates and outcomes (no tokens), including whether `about.get` worked with `drive.file`.

## Implementation Order
1. **Riskiest first, the loopback and the full in-process flow.** Write `loopback.ts`, `client-file.ts`, the minimal `main` and `output`, and the `auth` happy path, then run test 1 and `loopback.test.ts`. The real-socket callback and the state check are where this breaks.
2. Write `errors.ts` with exit codes, `config.ts` and `context.ts`.
3. Write `auth status`, `logout`, `DriveProvider.account()`, and `open-browser.ts`.
4. Write the remaining tests, the leak test, and the spawned smoke.
5. `pnpm format`, then `pnpm check`.
6. The owner's manual run against real Google, recorded.

## Security Considerations
- The loopback binds `127.0.0.1` only, accepts one valid callback, compares `state`, and never echoes request data.
- Code, verifier, tokens and client secret never reach stdout, stderr, pages or errors (leak test with control).
- The browser opener uses `spawn` without a shell (no command injection through the URL).
- Config and token files are owner-only (FN-08).

## Pattern to Copy
- `scripts/cli-output-mock.ts` for output rules and texts; port them, don't import.
- `packages/drive/test/oauth/no-secret-leak.test.ts` for the leak-test structure.
- `packages/drive/src/api/files.ts` for the zod response schema style (`about.ts`).

## Verification
- Command: `pnpm check` (green, with the new CLI test files).
- Command: `grep -rn "0\.0\.0\.0\|shell: true" packages/cli/src` (no output).
- Manual: the owner's real-Google run is recorded in this issue.
- Done when: the check is green and the leak test's control passes. The delivery carries the check counts, the verify-it report and the owner's manual-run record. If the manual run is pending at delivery, that is said explicitly and the issue stays `done` only after it is recorded.

## Out of Scope
- `doctor` (FN-10), file commands (FN-11), device flow and export/import (FN-17).
- Localizing output (English only in v1).

## Checkpoint
- `Checkpoint: sim`, after step 1: the auth flow and token handling are the security surface; run `pnpm check` once the loopback and the happy path pass.
