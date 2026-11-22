import {
  AuthError,
  ConflictError,
  NotFoundError,
  PermissionError,
  ProviderError,
  QuotaExceededError,
  RateLimitError,
} from '@byos/core';
import { describe, expect, it } from 'vitest';

import { CliError, exitCodeFor, report } from '../src/errors.js';
import { createOutput, supportsUnicode } from '../src/output.js';

function sinks() {
  let out = '';
  let err = '';
  return {
    out: { tty: false, write: (t: string) => (out += t) },
    err: { tty: false, write: (t: string) => (err += t) },
    stdout: () => out,
    stderr: () => err,
  };
}

const make = (
  json: boolean,
  env: Record<string, string> = {},
  platform: NodeJS.Platform = 'linux',
) => {
  const s = sinks();
  return { s, out: createOutput({ out: s.out, err: s.err, env, platform }, { json }) };
};

describe('human output', () => {
  it('puts results on stdout and warnings and errors on stderr', () => {
    const { s, out } = make(false);
    out.ok('done');
    out.step('working');
    out.rows([['key', 'value']]);
    out.warn('careful', 'detail line');
    out.fail('broken');
    expect(s.stdout()).toBe('✓ done\n› working\n  key  value\n');
    expect(s.stderr()).toBe('! careful\n  detail line\n✗ broken\n');
  });

  it('writes no escape codes to a sink that is not a terminal', () => {
    const { s, out } = make(false);
    out.ok(out.link('https://example.com'));
    out.warn('x');
    expect(s.stdout() + s.stderr()).not.toContain('\x1b[');
  });

  it('falls back to console-safe symbols on the legacy Windows console', () => {
    const { s, out } = make(false, {}, 'win32');
    out.ok('done');
    expect(s.stdout()).toBe('√ done\n');
    expect(supportsUnicode('win32', { WT_SESSION: 'x' })).toBe(true);
    expect(supportsUnicode('win32', { TERM_PROGRAM: 'vscode' })).toBe(true);
    expect(supportsUnicode('darwin', {})).toBe(true);
  });
});

describe('--json output', () => {
  it('prints only the data document on stdout', () => {
    const { s, out } = make(true);
    out.ok('hidden');
    out.step('hidden');
    out.rows([['a', 'b']]);
    out.warn('hidden');
    out.data({ id: 1 });
    expect(s.stdout()).toBe('{"id":1}\n');
    expect(s.stderr()).toBe('');
  });

  it('prints an error as one { code, message } line on stderr and nothing on stdout', () => {
    const { s, out } = make(true);
    const exit = report(out, new NotFoundError('no file at x'));
    expect(exit).toBe(3);
    expect(s.stdout()).toBe('');
    expect(JSON.parse(s.stderr())).toEqual({ code: 'NOT_FOUND', message: 'no file at x' });
  });

  it('adds the reason of an auth error, so a consumer can tell what to do', () => {
    const { s, out } = make(true);
    report(out, new AuthError('expired', { reason: 'testing-mode-expiry-suspected' }));
    expect(JSON.parse(s.stderr())).toEqual({
      code: 'AUTH_FAILED',
      message: 'expired',
      reason: 'testing-mode-expiry-suspected',
    });
  });
});

describe('errors', () => {
  it.each([
    [new NotFoundError('x'), 3],
    [new ConflictError('x'), 4],
    [new AuthError('x', { reason: 'missing-token' }), 5],
    [new QuotaExceededError('x'), 6],
    [new RateLimitError('x'), 7],
    [new PermissionError('x'), 1],
    [new ProviderError('x'), 1],
    [new ProviderError('x', { code: 'UPLOAD_SESSION_EXPIRED' }), 1],
    [new CliError('x', 2, 'USAGE'), 2],
    [new Error('x'), 1],
  ])('%s maps to the exit code in the PP-02 table', (error, exit) => {
    expect(exitCodeFor(error)).toBe(exit);
  });

  it('prints a human error as CODE: message on stderr', () => {
    const { s, out } = make(false);
    report(out, new ConflictError('a.txt already exists'));
    expect(s.stderr()).toBe('✗ CONFLICT: a.txt already exists\n');
    expect(s.stdout()).toBe('');
  });

  it('never prints the text of an unexpected error, which could carry a secret', () => {
    const { s, out } = make(false);
    const exit = report(out, new TypeError('fetch failed for https://x/?token=SECRET-token'));
    expect(exit).toBe(1);
    expect(s.stderr()).toBe('✗ UNEXPECTED: unexpected error (TypeError)\n');
    expect(s.stderr()).not.toContain('SECRET');
  });

  it('never prints a cause or a stack for a BYOS error', () => {
    const { s, out } = make(true);
    report(out, new ProviderError('upstream', { cause: new Error('SECRET inside the cause') }));
    expect(s.stderr()).not.toMatch(/SECRET|stack|at /);
  });
});
