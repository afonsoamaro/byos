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
