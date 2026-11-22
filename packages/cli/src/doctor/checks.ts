import { resolve } from 'node:path';

import { AuthError, ProviderError, type StoredToken } from '@byos/core';

import { loadDesktopClient, type DesktopClient } from '../client-file.js';
import { openProvider, TOKEN_KEY, type Context } from '../context.js';
import { CliError } from '../errors.js';
import { wholeDays } from '../time.js';
import { FIXES } from './fixes.js';

export type CheckId = 'client-file' | 'token' | 'drive-api' | 'scopes' | 'testing-mode';
export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface CheckResult {
  readonly id: CheckId;
  readonly status: CheckStatus;
  readonly message: string;
  readonly fix?: string;
}

const SCOPE_PREFIX = 'https://www.googleapis.com/auth/';
const ALLOWED_SCOPES = new Set([`${SCOPE_PREFIX}drive.file`, `${SCOPE_PREFIX}drive.appdata`]);

const result = (id: CheckId, status: CheckStatus, message: string, fix?: string): CheckResult => ({
  id,
  status,
  message,
  ...(fix === undefined ? {} : { fix }),
});

async function checkClient(
  ctx: Context,
  flag: string | undefined,
): Promise<{ check: CheckResult; client?: DesktopClient }> {
  const file = flag ? resolve(flag) : (await ctx.config.read()).clientFile;
  if (!file) {
    return { check: result('client-file', 'fail', 'No client file is set up', FIXES.noClient) };
  }
  try {
    const client = await loadDesktopClient(file);
    return {
      check: result('client-file', 'pass', 'Client file found, and it is a Desktop app'),
      client,
    };
  } catch (error) {
    if (error instanceof CliError && error.exitCode === 5) {
      return {
        check: result(
          'client-file',
          'fail',
          'The client file is not a Desktop app',
          FIXES.wrongType,
        ),
      };
    }
    const message = error instanceof CliError ? error.message : 'The client file could not be read';
    return { check: result('client-file', 'fail', message, FIXES.noClient) };
  }
}

/** Why a token can't be used, as a failed check with the step that fixes it. */
function tokenFailure(error: unknown): CheckResult {
  if (error instanceof AuthError) {
    return error.reason === 'testing-mode-expiry-suspected'
      ? result(
          'token',
          'fail',
          'Google rejected the refresh token about 7 days after consent',
          FIXES.publish,
        )
      : result('token', 'fail', 'The sign-in is no longer valid', FIXES.signIn);
  }
  return result('token', 'fail', "The token couldn't be refreshed", FIXES.network);
}

/**
 * Runs the checks in order. Each one that needs an earlier result is `skip` when that one
 * failed, so one root cause doesn't read as four problems.
 */
export async function runChecks(
  ctx: Context,
  options: { client?: string },
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const { check: clientCheck, client } = await checkClient(ctx, options.client);
  results.push(clientCheck);

  // The stored token, read once: the scopes check needs it even when the refresh fails.
  let stored: StoredToken | undefined;
  let storedError: unknown;
  try {
    stored = await ctx.store.load(TOKEN_KEY);
  } catch (error) {
    storedError = error;
  }

  let tokenOk = false;
  if (!client) {
    results.push(result('token', 'skip', 'Needs the client file first'));
  } else if (storedError !== undefined) {
    results.push(result('token', 'fail', "The stored sign-in can't be read", FIXES.signIn));
  } else if (!stored) {
    results.push(result('token', 'skip', 'Not signed in yet', FIXES.signIn));
  } else {
    try {
      await openProvider(ctx, client).tokens.getAccessToken();
      tokenOk = true;
      results.push(result('token', 'pass', 'Signed in, and the token is valid'));
    } catch (error) {
      results.push(tokenFailure(error));
    }
  }

  if (!client || !tokenOk) {
    results.push(result('drive-api', 'skip', 'Needs a valid sign-in first'));
  } else {
    try {
      await openProvider(ctx, client).provider.account();
      results.push(result('drive-api', 'pass', 'Drive API reachable'));
    } catch (error) {
      if (error instanceof ProviderError && error.message.includes('accessNotConfigured')) {
        results.push(
          result(
            'drive-api',
            'fail',
            'The Drive API is not enabled in your project',
            FIXES.enableApi,
          ),
        );
      } else if (error instanceof AuthError) {
        results.push(result('drive-api', 'fail', 'Drive rejected the sign-in', FIXES.signIn));
      } else {
        results.push(result('drive-api', 'fail', "Couldn't reach the Drive API", FIXES.network));
      }
    }
  }

  if (!stored) {
    results.push(result('scopes', 'skip', 'Needs a sign-in first'));
  } else {
    const extra = stored.scopes.filter((scope) => !ALLOWED_SCOPES.has(scope));
    results.push(
      extra.length === 0
        ? result(
            'scopes',
            'pass',
            `Scopes: ${stored.scopes.map((s) => s.replace(SCOPE_PREFIX, '')).join(', ')}`,
          )
        : result(
            'scopes',
            'warn',
            `More access than BYOS asks for: ${extra.map((s) => s.replace(SCOPE_PREFIX, '')).join(', ')}`,
            FIXES.extraScopes,
          ),
    );
  }

  // A reminder, never a check: the publishing status isn't readable through any API.
  const age = stored
    ? ` Consent was given ${String(wholeDays(stored.consentedAt, ctx.io.now()))} days ago.`
    : '';
  results.push(
    result(
      'testing-mode',
      'warn',
      `If your OAuth consent screen is in Testing, Google expires refresh tokens 7 days after consent and limits the app to 100 test users. BYOS can't read the publishing status through the API, so this is a reminder, not a check.${age}`,
      FIXES.testingMode,
    ),
  );
  return results;
}

/** 0 with only passes, warnings and skips; 5 when the setup or the sign-in failed; else 1. */
export function exitCodeForChecks(results: readonly CheckResult[]): number {
  const failed = results.filter((r) => r.status === 'fail');
  if (failed.length === 0) return 0;
  return failed.some((r) => r.id === 'client-file' || r.id === 'token') ? 5 : 1;
}
