# [FN-03] Drive OAuth: PKCE, code exchange and refresh

## Type
Functional

Checkpoint: sim (security: tokens and OAuth flow)

## Description
`@byos/drive` builds the Google authorization URL, exchanges the authorization code, and keeps the access token fresh, using only `fetch` against Google's OAuth endpoints. The redirect transport (loopback server, deep link) belongs to the consumer.

## User Flow
1. Consumer calls `createAuthRequest({ clientId, redirectUri, scopes })` and gets `{ url, codeVerifier, state }`.
2. User consents; the consumer receives `code` and `state` at its redirect.
3. Consumer calls `exchangeCode({ code, codeVerifier, ... })` and gets a `StoredToken`, which it saves in its `TokenStore`.
4. Later, the provider loads the token, refreshes it when needed, and saves the refreshed token back.

## Requirements
- PKCE S256 on every request (code verifier from Web Crypto `getRandomValues`, 43–128 chars), random `state`, `access_type=offline`, `prompt=consent` only on first connect.
- Scopes: default `drive.file`; `drive.appdata` allowed; **any other Drive scope (`drive`, `drive.readonly`, `drive.metadata*`) is rejected with an error at `createAuthRequest`**. This is a product rule (see SPECS: Onboarding).
- `exchangeCode` and `refresh` POST to the token endpoint with `fetch`; client secret is optional (Desktop clients get one that Google treats as non-confidential; mobile clients have none).
- `StoredToken.consentedAt` is set on code exchange and kept across refreshes; granted scopes come from the token response, not from what was requested.
- Token manager used by the provider: refresh when `expiresAt` is within 60 s, and once on a 401; concurrent callers share one in-flight refresh.
- `invalid_grant` on refresh → `AuthError` with reason `testing-mode-expiry-suspected` when `now - consentedAt` is between 6.5 and 8 days, else `invalid-grant`. The message explains the Testing-mode 7-day expiry and the fix (publish the consent screen).
- **Security**: tokens, codes, code verifiers and client secrets never appear in logs, thrown error messages, event hooks, or `JSON.stringify` of errors. Error messages never embed request URLs or bodies.
- `revoke(token)` calls Google's revoke endpoint.
- `fetch` is injectable.

## Scenarios
### Happy Path
- Code exchange returns a token with refresh token; a later call with an expired access token refreshes transparently and saves the new token.
### Edge Cases
- Two concurrent requests with an expired token cause exactly one refresh.
- Token response without `refresh_token` on reconnect keeps the stored refresh token.
### Error Handling
- `invalid_grant` at day 7 maps to `testing-mode-expiry-suspected`; at day 30 maps to `invalid-grant`.
- Network failure during refresh surfaces a `ProviderError` without the URL or token.

## Data Requirements
- `StoredToken` from FN-01.

## External Dependencies
- Google OAuth 2.0 endpoints (authorization, token, revoke). Tests use an injected `fetch`; no network in the gate.

## Acceptance Criteria
- [ ] Authorization URL carries PKCE S256, `state`, `access_type=offline` and only allowed scopes; disallowed scopes throw.
- [ ] Code exchange and refresh work against a fake `fetch`, including the shared in-flight refresh.
- [ ] `invalid_grant` maps to the right `AuthError` reason by token age.
- [ ] A test captures all errors, hook events and console output during a full flow and asserts the access token, refresh token, code, verifier and client secret never appear.
- [ ] Zero Node built-in imports.

## Dependencies
- FN-01.

---

# Implementation Plan

## Prerequisites
- FN-01 done: `StoredToken`, `TokenStore`, `AuthError` (reasons `invalid-grant`, `testing-mode-expiry-suspected`, `missing-token`, `scope-missing`), `ProviderError`, `retry`, `RetryOptions`, `ByosEvents` and `ByosError.toJSON` (no `cause`, no `stack`) exist in `@byos/core`.
- Branch `feat/FN-03-drive-oauth` from an up-to-date `main`.
- Node 26 (`source ~/.nvm/nvm.sh && nvm use 26`).
- Add `zod` `4.6.7` to `packages/drive` `dependencies`, exact pin. It is the version SPECS lists and still the latest (`npm view zod version` gave `4.6.7`, published 2026-10-12, well past the 24 h install window). Run `pnpm --filter @byos/drive add zod@4.6.7 --save-exact`, and stage `pnpm-lock.yaml` with the change: an explicit `git add` of only the touched files leaves the lockfile out.

## Reusable Code Found
- `@byos/core`:
  - `StoredToken` (`accessToken`, `refreshToken?`, `expiresAt` and `consentedAt` in epoch ms, `scopes`) and `TokenStore` (`load`, `save`, `clear`);
  - `AuthError` and `ProviderError`;
  - `retry` (full jitter; never retries `AuthError`) and `RetryOptions` (`random`, `maxAttempts`, `onRetry`, `operation`);
  - `ByosEvents.onRequest` and `onRetry`.
- `packages/drive/src/index.ts`: `PACKAGE_NAME` and `REQUIRES`. Keep both; add exports.
- `packages/drive/tsconfig.json`: `lib: ["es2024", "dom"]`, `types: []`. `fetch`, `Response`, `URLSearchParams`, `crypto.getRandomValues` and `crypto.subtle` come from the `dom` lib.
- `packages/core/test/retry.test.ts` and `packages/core/test/errors.test.ts`: the test style (vitest, `vi.fn`, `rejects.toBeInstanceOf`, an error's `JSON.stringify` scanned for secrets).
- `tests/portability.test.ts` already bundles `drive/index` for the browser, so zod and the new modules are covered by that guard.

## Knowledge Registry
- **Testing without the network:** pass an injected `fetch` that returns `new Response(JSON.stringify(body), { status, headers })`; no mock library is needed. Lock the global `fetch` in tests with `vi.stubGlobal('fetch', ...)`, a function that fails the test if called, so nothing can fall back to the real network.
- **Proving an absence:** an absence test needs a control case that proves the capture works. The secret-leak test first asserts that its capture *did* record the events and errors (non-empty), then asserts the secrets are absent.
- **Zod 4:** `.refine` runs even when a field already failed, so don't call throwing functions inside one. The token schema needs no refine.

## Architecture Decisions
- **Endpoints and scopes, as constants in `oauth/constants.ts`:**
  - authorize `https://accounts.google.com/o/oauth2/v2/auth`, token `https://oauth2.googleapis.com/token`, revoke `https://oauth2.googleapis.com/revoke`;
  - `DRIVE_SCOPES = { 'drive.file': 'https://www.googleapis.com/auth/drive.file', 'drive.appdata': 'https://www.googleapis.com/auth/drive.appdata' }`.
  - `[assumed]` These are Google's documented endpoints. The real round trip is first exercised in FN-09's manual smoke, and nothing in this issue calls them.
- **`createAuthRequest`:**
  - `options`: `{ clientId: string; redirectUri: string; scopes?: readonly DriveScope[]; forceConsent?: boolean; loginHint?: string }`, where `type DriveScope = 'drive.file' | 'drive.appdata'` and `scopes` defaults to `['drive.file']`;
  - returns `Promise<{ url: string; codeVerifier: string; state: string }>`;
  - **scope rule:** every requested scope must be a key of `DRIVE_SCOPES`. Anything else (a JS caller passing `'drive'`, `'drive.readonly'`, `'drive.metadata.readonly'` or a full URL) throws `ProviderError('scope not allowed: <scope>. BYOS requests only drive.file and drive.appdata')` before any crypto. Empty `scopes` also throws;
  - **parameters:** `response_type=code`, `client_id`, `redirect_uri`, `scope` (space-joined full URLs), `state`, `code_challenge`, `code_challenge_method=S256`, `access_type=offline`, plus `prompt=consent` when `forceConsent` (default `true`: a connect from scratch needs it to get a refresh token, and a consumer that already holds one passes `false`) and `login_hint` when given;
  - built with `URL` and `URLSearchParams`.
- **PKCE (`oauth/pkce.ts`):**
  - `codeVerifier` is 32 bytes from `crypto.getRandomValues`, base64url without padding, which gives 43 characters, inside 43 to 128;
  - `codeChallenge` is `base64url(sha256(verifier))` via `crypto.subtle.digest('SHA-256', ...)`;
  - `state` is 16 random bytes, base64url;
  - `base64url(bytes)` is a small hand-written encoder, because `btoa` and `Buffer` are not reliable across RN and the browser.
  - Requirement for consumers, documented on the module: `globalThis.crypto.getRandomValues` and `crypto.subtle.digest`. Node 26 and browsers have both; an Expo app must provide a polyfill (the Expo app is a later spec).
- **Token client (`oauth/token-client.ts`)**, three functions, each taking `fetch?: typeof fetch` (default `globalThis.fetch`) and `now?: () => number` (default `Date.now`):
  - `exchangeCode({ clientId, clientSecret?, code, codeVerifier, redirectUri, fetch?, now? }): Promise<StoredToken>` POSTs `grant_type=authorization_code`. `consentedAt = now()`, `expiresAt = now() + expires_in * 1000`, and `scopes` comes from the response `scope` (space-split), never from the request. A response without `refresh_token` is still a valid `StoredToken`; the manager keeps the old one on reconnect (see below).
  - `refreshToken({ clientId, clientSecret?, token: StoredToken, fetch?, now? }): Promise<StoredToken>` POSTs `grant_type=refresh_token`. It keeps `consentedAt` and keeps `token.refreshToken` when the response has none, and `scopes` comes from the response when present, else from the old token. With no `refreshToken`, it throws `AuthError('no refresh token stored; run the sign-in again', { reason: 'missing-token' })`.
  - `revokeToken({ token: string, fetch? }): Promise<void>` POSTs `token=<token>` to the revoke endpoint. A 200 resolves; anything else throws `ProviderError('token revoke failed (HTTP <status>)')`.
  - The body is `application/x-www-form-urlencoded` via `URLSearchParams`. `client_secret` is sent only when given.
  - The response is validated with zod: `{ access_token: string, expires_in: number (positive), refresh_token?: string, scope?: string, token_type: string }`, with `.passthrough()` off and unknown keys stripped. A bad shape throws `ProviderError('unexpected token response from Google')`.
- **Error mapping (`oauth/errors.ts`, `mapTokenError(status, body, context)`)**, with `context` being `{ grant: 'authorization_code' | 'refresh_token'; consentedAt?: number; now: number }`:
  - `fetch` itself rejects (network): `ProviderError('network error contacting Google OAuth (<error.name>)')` with **no `cause`**. A runtime's fetch error can carry the request in its cause chain, and the message must stay free of URL and body;
  - 400 with `error: 'invalid_grant'` on refresh: `AuthError` with reason `testing-mode-expiry-suspected` when `now - consentedAt` is between 6.5 and 8 days (inclusive), else `invalid-grant`.
    - The testing-mode message: `Google rejected the refresh token about 7 days after consent. If your OAuth consent screen is in Testing, Google expires refresh tokens after 7 days: publish the app (Google Cloud console › OAuth consent screen › Publish app), then sign in again.`
    - The `invalid-grant` message: `Google rejected the refresh token (revoked or expired); sign in again.`
  - 400 `invalid_grant` on code exchange: `AuthError('the authorization code was rejected (expired, reused, or the verifier does not match); sign in again', { reason: 'invalid-grant' })`;
  - any other 4xx: `ProviderError('Google OAuth rejected the request: <error>')`, where `<error>` is only Google's short `error` code (`invalid_client`, `unauthorized_client`, ...), matched against `/^[a-z_]+$/` and replaced by `unknown_error` otherwise. Never `error_description` and never the body;
  - 5xx: `ProviderError('Google OAuth is unavailable (HTTP <status>)')`, which `retry` treats as retryable.
- **`TokenManager` (`oauth/token-manager.ts`):**
  - constructor options: `{ store: TokenStore; key: string; clientId: string; clientSecret?: string; fetch?; now?; events?: ByosEvents; retry?: RetryOptions }`;
  - `getAccessToken(): Promise<string>` loads from the store on first use and keeps the token in memory. A missing token throws `AuthError('not signed in; run the sign-in first', { reason: 'missing-token' })`. If `expiresAt - now() <= 60_000`, it refreshes, then returns `accessToken`;
  - `handleUnauthorized(rejectedAccessToken: string): Promise<string>` is for the provider's single retry on a 401. If the in-memory token already differs from `rejectedAccessToken`, another caller refreshed, so it returns the current one; otherwise it forces a refresh;
  - **a refresh** runs `retry(() => refreshToken(...), { maxAttempts: 3, operation: 'oauth.refresh', onRetry: events?.onRetry, ...options.retry })`, then `store.save(key, refreshed)`, then updates memory. Concurrent callers share one in-flight `Promise`, kept in a private field and cleared in `finally`;
  - `events.onRequest?.({ operation: 'oauth.refresh', attempt })` fires per attempt (inside the retried function);
  - `clear(): Promise<void>` calls `store.clear(key)` and drops memory. It never revokes; revoking is `revokeToken`, which the CLI calls on logout.
- **Reconnect without a `refresh_token`:** a helper does the merge.
  - `mergeReconnect(previous: StoredToken | undefined, fresh: StoredToken): StoredToken` keeps `previous.refreshToken` when `fresh.refreshToken` is absent.
  - The CLI (FN-09) calls it before `store.save`. Keeping it a pure exported function keeps `exchangeCode` free of store access.
- **No secret in any message:** messages are built only from constants, HTTP status codes, Google's short `error` code (whitelisted by regex) and error class names. No logging at all (`console` is never called in `src`).
- **Folder:** `packages/drive/src/oauth/`, re-exported from `packages/drive/src/index.ts`.

## Files to Create
| File | Purpose |
|------|---------|
| `packages/drive/src/oauth/constants.ts` | Endpoints, `DRIVE_SCOPES`, `DriveScope` |
| `packages/drive/src/oauth/pkce.ts` | `base64url`, `createCodeVerifier`, `codeChallengeFor`, `createState` |
| `packages/drive/src/oauth/auth-request.ts` | `createAuthRequest` and its option types |
| `packages/drive/src/oauth/errors.ts` | `mapTokenError`, `networkError`, the Testing-mode age window |
| `packages/drive/src/oauth/token-client.ts` | `exchangeCode`, `refreshToken`, `revokeToken`, `mergeReconnect`, the zod response schema |
| `packages/drive/src/oauth/token-manager.ts` | `TokenManager` |
| `packages/drive/test/oauth/fake-google.ts` | Test helper: a scripted `fetch` that records requests and replies from a queue |
| `packages/drive/test/oauth/auth-request.test.ts` | URL, PKCE and scope rule |
| `packages/drive/test/oauth/token-client.test.ts` | Exchange, refresh, revoke and error mapping |
| `packages/drive/test/oauth/token-manager.test.ts` | Expiry window, shared refresh, 401 path, store writes |
| `packages/drive/test/oauth/no-secret-leak.test.ts` | The full-flow leak test |

For the test files, copy the layout of `packages/core/test/retry.test.ts`. The `packages/drive/test/tsconfig.json` `include` must cover the `test/oauth/` subfolder: check it includes `.` recursively (it mirrors core's, which does), and leave it alone if so.

## Files to Modify
| File | Changes |
|------|---------|
| `packages/drive/package.json` | `dependencies.zod: "4.6.7"` (via `pnpm add`) |
| `pnpm-lock.yaml` | Updated by the install; commit it |
| `packages/drive/src/index.ts` | Re-export `createAuthRequest`, `exchangeCode`, `refreshToken`, `revokeToken`, `mergeReconnect`, `TokenManager`, `DRIVE_SCOPES`, and the types `DriveScope`, `AuthRequest`, `AuthRequestOptions`, `TokenManagerOptions` |
| `issues/FN-03-drive-oauth.md` | Execution Record |
| `issues/_index.md` | FN-03 `todo` → `planned` now; `done` only by verify-it |

Don't touch `packages/core` or `packages/cli`.

## Data Requirements
- `StoredToken` from FN-01; no new storage.

## Testing Strategy
- **`fake-google.ts`:** `fakeGoogle(replies: Array<{ status: number; body: unknown } | Error>)` returns `{ fetch, requests }`.
  - `fetch` shifts the next reply (an `Error` is thrown as a network failure), records `{ url, method, body: Object.fromEntries(new URLSearchParams(init.body)) }`, and returns `new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })`.
  - Every test file runs `vi.stubGlobal('fetch', () => { throw new Error('real fetch called') })` in `beforeEach` and `vi.unstubAllGlobals()` in `afterEach`.
- `auth-request.test.ts`:
  - parse the returned URL: host and path, `code_challenge_method=S256`, `access_type=offline`, `prompt=consent` by default and absent with `forceConsent: false`, `scope` equals the drive.file URL, the `state` matches the returned `state`;
  - `code_challenge` equals `base64url(sha256(codeVerifier))`, recomputed in the test with `crypto.subtle`;
  - the verifier length is between 43 and 128 and matches `/^[A-Za-z0-9_-]+$/`;
  - two calls give different verifiers and states;
  - `['drive.file', 'drive.appdata']` is accepted;
  - `'drive'`, `'drive.readonly'`, `'drive.metadata.readonly'`, a full `https://www.googleapis.com/auth/drive` and `[]` each throw `ProviderError`;
  - `base64url` known vectors: empty bytes give `''`, `[0xfb, 0xff]` gives `'-_8'`.
- `token-client.test.ts`:
  - exchange: the request body has `grant_type=authorization_code`, `code_verifier`, `redirect_uri`, and `client_secret` only when given. The result has `consentedAt === now` and `expiresAt === now + expires_in*1000`, and its scopes come from the response even when it grants fewer scopes than were requested;
  - refresh keeps `consentedAt` and keeps the old `refreshToken` when the response has none;
  - `invalid_grant` on refresh at `consentedAt = now - 7 days` gives `testing-mode-expiry-suspected`; at 30 days, and at 6 days, it gives `invalid-grant`; at exactly 6.5 and 8 days it gives `testing-mode-expiry-suspected`;
  - `invalid_grant` on exchange gives `AuthError` `invalid-grant`;
  - `invalid_client` gives `ProviderError` with `invalid_client` in the message, and an `error` value like `'<script>'` shows up as `unknown_error`;
  - a 503 gives `ProviderError`;
  - a network `TypeError` gives `ProviderError` with no `cause`;
  - a malformed 200 (missing `access_token`) gives `ProviderError`;
  - revoke: 200 resolves, 400 throws `ProviderError`;
  - `mergeReconnect` keeps the previous refresh token only when the fresh one lacks it.
- `token-manager.test.ts`, with a `MemoryStore` defined in the test (a `Map` behind `TokenStore`):
  - a fresh token is returned with 0 fetches;
  - a token with `expiresAt = now + 59_000` refreshes and saves (with `now + 61_000` it doesn't);
  - **five concurrent `getAccessToken()` calls on an expired token make exactly 1 token request**, and the store's `save` is called once;
  - `handleUnauthorized` with the current access token refreshes once, and with a stale value returns the current token without fetching;
  - a 503 then a 200 refreshes after one retry (`retry: { random: () => 0 }`), and `onRetry` fires;
  - `invalid_grant` is not retried (1 request) and propagates `AuthError`;
  - an empty store gives `AuthError` `missing-token`;
  - `clear()` empties the store.
- `no-secret-leak.test.ts`, with distinctive secret values (`AT-secret-1`, `RT-secret-1`, `CODE-secret`, the generated verifier, `CS-secret`, `AT-secret-2`):
  - spy on all `console` methods;
  - capture every `events` callback payload;
  - run a full flow: `createAuthRequest`; `exchangeCode` with the client secret; save; a `TokenManager` with an expired token, which refreshes and returns `AT-secret-2`; then a 503-then-`invalid_grant` refresh failure, a network failure, and an `invalid_client`;
  - collect every thrown error as `message`, `String(error)`, `JSON.stringify(error)` and `error.stack`;
  - control: assert that at least 3 errors and at least 2 event payloads were captured;
  - then assert that none of the secret strings appears in the joined capture, and that `console` was never called.
- The root `tests/portability.test.ts` still bundles `drive/index` (with zod) for the browser.

## Implementation Order
1. **Riskiest first, dependency and bundle.** Run `pnpm --filter @byos/drive add zod@4.6.7 --save-exact`, write `constants.ts`, `pkce.ts` and `auth-request.ts`, export `createAuthRequest`, then run `pnpm --filter @byos/drive build` and `pnpm vitest run tests/portability.test.ts` from the root. This proves zod plus Web Crypto use bundles for the browser with no Node import before the token code depends on it.
2. Write `errors.ts` and `token-client.ts`.
3. **Checkpoint:** run `pnpm check` once here, because the security-relevant mapping and the token shapes are fixed.
4. Write `token-manager.ts`.
5. Write `fake-google.ts` and the four test files.
6. `pnpm format`, then `pnpm check`.

## Security Considerations
- Secrets (access token, refresh token, code, verifier, client secret) appear only in request bodies sent to `fetch` and in returned `StoredToken`s. They never appear in error messages, error `cause`s, event payloads or `console` output, which the leak test proves.
- Error messages never include request URLs or bodies, and Google's `error_description` is dropped.
- Only `drive.file` and `drive.appdata` can be requested: the product rule from SPECS (Onboarding), enforced in code and tested.
- `state` and the verifier come from `crypto.getRandomValues`, never `Math.random`.
- The `state` comparison on the redirect belongs to the consumer's redirect handler (FN-09). The returned `state` is what it compares against, and that is documented on `createAuthRequest`.

## Pattern to Copy
- `packages/core/test/retry.test.ts` and `packages/core/test/errors.test.ts` for test layout and the secret-in-JSON check.
- `packages/core/src/retry.ts` for the module shape (options object with defaults, doc comment).

## Verification
- Command: `pnpm check` (green, including the four new drive test files and the browser bundle of `drive/index` with zod).
- Command: `grep -rn "node:\|console\." packages/drive/src` (no output).

## Out of Scope
- The loopback server, opening the browser, comparing `state` on the redirect, and fetching the account email for display: all FN-09. Note for FN-09: `drive.file` does not return the email in the token response, so it reads the account from Drive's `about.get` (`fields=user(emailAddress)`) after sign-in.
- The Drive request layer and its 401 handling (FN-04), which calls `TokenManager.handleUnauthorized`.
- The CLI token store (FN-08) and headless auth for servers (FN-17).
- A Web Crypto polyfill for React Native.

## Checkpoint
- `Checkpoint: sim`, after step 2 (token client and error mapping fixed), before the manager.

---

# Execution Record

- Branch `feat/FN-03-drive-oauth`, executed 2026-11-20.
- Step 1 (riskiest): `zod@4.6.7` added as an exact dependency of `@byos/drive`. The drive build and the browser bundle passed. zod entered the bundle with the token client in step 2, and the Checkpoint's `pnpm check` (browser bundle included) passed with it: build, lint, typecheck, 96 tests.
- Deviations from the plan:
  - `TokenManager.handleUnauthorized` also joins a refresh already in flight, instead of starting a second one, when a 401 arrives during another caller's refresh.
  - The leak test feeds secrets into Google's `error_description` and into the network error's message (a URL carrying a refresh token), so the "dropped" paths are exercised, not only the happy path.
- Mutation check: making the network error carry the original `fetch` error message failed the leak test. Restored.
- First final `pnpm check` failed on lint with one `no-unnecessary-type-assertion` in `test/oauth/fake-google.ts`. Removed, and the rerun passed.
- `pnpm check`: build, lint (ESLint 0 warnings, Prettier clean), typecheck and tests green: 135 passed (67 in core, 41 in drive, 2 in cli, 25 in the root suite). `grep -rn "node:\|console\." packages/drive/src` prints nothing.
- Fixes after the independent verification (98, no vetoes):
  - **`clear()` during a refresh:** the refresh finishing afterwards used to write the token back to the store, undoing a sign-out. A generation counter now makes that refresh reject with `AuthError` `missing-token` and save nothing. Tested.
  - Added a test for a 401 arriving during another caller's refresh (it joins it; 1 request).
  - The leak test also asserts that no captured error carries a `cause`.
  - The first version of that fix checked the generation only after the refresh, and its test failed: a `clear()` that lands while the token is still being *loaded* from the store let the load resurrect it. The load now also checks the generation. Both windows are tested: the sign-out during the store load, and the sign-out while the refresh request is in flight (a `fetch` held open until after `clear()`).
- Final `pnpm check` after the fixes: green, 138 tests (67 in core, 44 in drive, 2 in cli, 25 in the root suite). Mutation check: disabling the refresh-side generation guard failed the in-flight sign-out test. Restored.
