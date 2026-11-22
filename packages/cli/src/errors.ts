import { AuthError, ByosError } from '@byos/core';

import type { Output } from './output.js';

/** A failure the CLI itself raises (a bad client file, a cancelled sign-in, a usage mistake). */
export class CliError extends Error {
  readonly exitCode: number;
  readonly code: string;

  constructor(message: string, exitCode: number, code = 'CLI_ERROR') {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.code = code;
  }
}

// docs/cli-output.md: 0 success, 1 anything else, 2 usage, 3 not found, 4 conflict, 5 auth,
// 6 quota, 7 rate limited after retries, 130 interrupted.
const EXIT_BY_CODE: Readonly<Record<string, number>> = {
  NOT_FOUND: 3,
  CONFLICT: 4,
  AUTH_FAILED: 5,
  QUOTA_EXCEEDED: 6,
  RATE_LIMITED: 7,
};

export function exitCodeFor(error: unknown): number {
  if (error instanceof CliError) return error.exitCode;
  if (error instanceof ByosError) return EXIT_BY_CODE[error.code] ?? 1;
  return 1;
}

export function codeFor(error: unknown): string {
  if (error instanceof CliError || error instanceof ByosError) return error.code;
  return 'UNEXPECTED';
}

/**
 * Prints an error the way PP-02 says and returns its exit code. Only the code and the message
 * (plus an auth `reason`) are shown: never a cause, a stack, or the text of an unknown error.
 */
export function report(out: Output, error: unknown): number {
  const code = codeFor(error);
  const message =
    error instanceof CliError || error instanceof ByosError
      ? error.message
      : `unexpected error (${error instanceof Error ? error.name : 'unknown'})`;
  const reason = error instanceof AuthError ? error.reason : undefined;
  out.jsonError({ code, message, ...(reason === undefined ? {} : { reason }) });
  out.fail(`${code}: ${message}`);
  return exitCodeFor(error);
}
