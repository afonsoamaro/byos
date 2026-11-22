import { resolve } from 'node:path';

import { AuthError } from '@byos/core';
import { createAuthRequest, exchangeCode, mergeReconnect, revokeToken } from '@byos/drive';
import type { Command } from 'commander';

import { loadDesktopClient } from '../client-file.js';
import { openContext, openProvider, TOKEN_KEY, type GlobalFlags } from '../context.js';
import { startLoopback } from '../auth/loopback.js';
import { CliError } from '../errors.js';
import type { CliIO } from '../io.js';
import { DAY_MS, describeDuration, isoDate, relativeTime, wholeDays } from '../time.js';

const SCOPE_PREFIX = 'https://www.googleapis.com/auth/';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
/** Past this age the Testing-mode warning shows: Google expires refresh tokens at 7 days. */
const TESTING_MODE_WARNING_DAYS = 6;

const shortScopes = (scopes: readonly string[]) =>
  scopes.map((scope) =>
    scope.startsWith(SCOPE_PREFIX) ? scope.slice(SCOPE_PREFIX.length) : scope,
  );

interface AuthFlags extends GlobalFlags {
  readonly client?: string;
}

/** `byos auth`: loopback OAuth with PKCE, then save the token and show the account. */
export async function runAuth(io: CliIO, flags: AuthFlags): Promise<void> {
  const ctx = openContext(io, flags);
  const { out } = ctx;
  const config = await ctx.config.read();
  const clientFile = flags.client ? resolve(flags.client) : config.clientFile;
  if (!clientFile) {
    throw new CliError(
      'no client file yet: run byos auth --client <path to the Desktop client JSON>',
      2,
      'USAGE',
    );
  }
  const client = await loadDesktopClient(clientFile);
  const existing = await ctx.store.load(TOKEN_KEY).catch((error: unknown) => {
    if (error instanceof AuthError) return undefined;
    throw error;
  });

  const timeoutMs = io.authTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const loopback = await startLoopback({ timeoutMs });
  try {
    // A fresh connect needs the consent screen to get a refresh token; a reconnect doesn't.
    const request = await createAuthRequest({
      clientId: client.clientId,
      redirectUri: loopback.redirectUri,
      forceConsent: existing === undefined,
    });
    const code = loopback.expect(request.state);
    out.step(`Opening your browser to sign in to Google${out.sym.wait}`);
    out.line('  If no browser opened, visit:');
    out.line(`  ${out.link(request.url)}`);
    // A person has to open this, so it is shown even under --json, as one line on stderr.
    if (out.json) io.err.write(`${request.url}\n`);
    void io.openBrowser(request.url);
    out.line(`${out.sym.wait} Waiting for Google (times out in ${describeDuration(timeoutMs)})`);

    const fresh = await exchangeCode({
      clientId: client.clientId,
      ...(client.clientSecret === undefined ? {} : { clientSecret: client.clientSecret }),
      code: await code,
      codeVerifier: request.codeVerifier,
      redirectUri: loopback.redirectUri,
      fetch: io.fetch,
      now: io.now,
    });
    const token = mergeReconnect(existing, fresh);
    await ctx.store.save(TOKEN_KEY, token);
    await ctx.config.write({ ...config, clientFile });

    const account = await openProvider(ctx, client).provider.account();
    await ctx.config.write({ clientFile, account });
    out.ok(`Connected as ${account.email}`);
    out.rows([['scopes', shortScopes(token.scopes).join(' ')]]);
    out.data({ account: account.email, scopes: token.scopes });
  } finally {
    loopback.close();
  }
}

/** `byos auth status`: who is signed in, with no network. */
export async function runStatus(io: CliIO, flags: GlobalFlags): Promise<void> {
  const ctx = openContext(io, flags);
  const { out } = ctx;
  const token = await ctx.store.load(TOKEN_KEY);
  if (!token) throw new CliError('not signed in; run byos auth', 5, 'AUTH_FAILED');
  const config = await ctx.config.read();
  const now = io.now();
  const days = wholeDays(token.consentedAt, now);
  const warn = now - token.consentedAt > TESTING_MODE_WARNING_DAYS * DAY_MS;

  out.rows(
    [
      ['account', config.account?.email ?? '(unknown)'],
      ['scopes', shortScopes(token.scopes).join(' ')],
      ['consented', `${isoDate(token.consentedAt)} (${relativeTime(token.consentedAt, now)})`],
      ['token', `access token expires ${relativeTime(token.expiresAt, now)}`],
    ],
    '',
  );
  out.data({
    account: config.account?.email ?? null,
    scopes: token.scopes,
    consentedAt: new Date(token.consentedAt).toISOString(),
    expiresAt: new Date(token.expiresAt).toISOString(),
    testingModeWarning: warn,
  });
  if (warn) {
    out.errLine();
    out.warn(
      `Consent is ${String(days)} days old. If your Google Cloud consent screen is in Testing, Google expires the refresh token after 7 days.`,
      `Publish the app (OAuth consent screen ${out.sym.step} Publish app) or run byos auth again.`,
    );
  }
}

/** `byos auth logout`: revoke the token at Google, then forget it locally. */
export async function runLogout(io: CliIO, flags: GlobalFlags): Promise<void> {
  const ctx = openContext(io, flags);
  const { out } = ctx;
  const token = await ctx.store.load(TOKEN_KEY).catch((error: unknown) => {
    // A token that can't be read can't be revoked, but it can still be removed.
    if (error instanceof AuthError) return undefined;
    throw error;
  });
  if (token) {
    try {
      await revokeToken({ token: token.refreshToken ?? token.accessToken, fetch: io.fetch });
    } catch {
      out.warn("Couldn't revoke the sign-in at Google; the local sign-in is removed anyway.");
    }
  }
  await ctx.store.clear(TOKEN_KEY);
  const config = await ctx.config.read();
  if (config.account) {
    const { account: _removed, ...rest } = config;
    await ctx.config.write(rest);
  }
  out.ok('Signed out');
  out.data({ signedOut: true });
}

export function registerAuth(program: Command, io: CliIO): void {
  const auth = program
    .command('auth')
    .description('Sign in to Google Drive (opens your browser)')
    .option('--client <file>', 'the Desktop app OAuth client JSON from Google Cloud');
  auth.action(async (_options: unknown, command: Command) => {
    await runAuth(io, command.optsWithGlobals<AuthFlags>());
  });
  auth
    .command('status')
    .description('Show who is signed in')
    .action(async (_options: unknown, command: Command) => {
      await runStatus(io, command.optsWithGlobals<GlobalFlags>());
    });
  auth
    .command('logout')
    .description('Revoke the sign-in and forget it')
    .action(async (_options: unknown, command: Command) => {
      await runLogout(io, command.optsWithGlobals<GlobalFlags>());
    });
}
