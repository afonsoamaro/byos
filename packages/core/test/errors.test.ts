import { describe, expect, it } from 'vitest';

import {
  AuthError,
  ByosError,
  ConflictError,
  ERROR_CODES,
  NotFoundError,
  PermissionError,
  ProviderError,
  QuotaExceededError,
  RateLimitError,
  isByosError,
} from '../src/index.js';

describe('error codes', () => {
  it('are the codes the CLI output reference (PP-02) documents', () => {
    expect(ERROR_CODES).toEqual([
      'NOT_FOUND',
      'CONFLICT',
      'PERMISSION_DENIED',
      'AUTH_FAILED',
      'RATE_LIMITED',
      'QUOTA_EXCEEDED',
      'UPLOAD_SESSION_EXPIRED',
      'PROVIDER_ERROR',
    ]);
  });

  it.each([
    [new NotFoundError('x'), 'NOT_FOUND', 'NotFoundError'],
    [new ConflictError('x'), 'CONFLICT', 'ConflictError'],
    [new PermissionError('x'), 'PERMISSION_DENIED', 'PermissionError'],
    [new AuthError('x', { reason: 'missing-token' }), 'AUTH_FAILED', 'AuthError'],
    [new RateLimitError('x'), 'RATE_LIMITED', 'RateLimitError'],
    [new QuotaExceededError('x'), 'QUOTA_EXCEEDED', 'QuotaExceededError'],
    [new ProviderError('x'), 'PROVIDER_ERROR', 'ProviderError'],
  ])('%s carries its code and name and is a ByosError', (error, code, name) => {
    expect(error.code).toBe(code);
    expect(error.name).toBe(name);
    expect(error).toBeInstanceOf(ByosError);
    expect(error).toBeInstanceOf(Error);
    expect(isByosError(error)).toBe(true);
  });

  it('ProviderError takes the upload-session code', () => {
    expect(new ProviderError('x', { code: 'UPLOAD_SESSION_EXPIRED' }).code).toBe(
      'UPLOAD_SESSION_EXPIRED',
    );
  });

  it('ProviderError is retryable unless told otherwise or the session expired', () => {
    expect(new ProviderError('x').retryable).toBe(true);
    expect(new ProviderError('x', { retryable: false }).retryable).toBe(false);
    expect(new ProviderError('x', { code: 'UPLOAD_SESSION_EXPIRED' }).retryable).toBe(false);
  });

  it('keeps reason, retryAfterMs and cause', () => {
    const cause = new Error('underlying');
    const auth = new AuthError('expired', { reason: 'testing-mode-expiry-suspected', cause });
    expect(auth.reason).toBe('testing-mode-expiry-suspected');
    expect(auth.cause).toBe(cause);
    expect(new RateLimitError('slow down', { retryAfterMs: 2000 }).retryAfterMs).toBe(2000);
  });

  it('isByosError rejects other errors', () => {
    expect(isByosError(new Error('x'))).toBe(false);
    expect(isByosError('NOT_FOUND')).toBe(false);
  });
});

describe('JSON form', () => {
  it('never carries the cause or the stack, so a token in the cause cannot leak', () => {
    const error = new AuthError('refresh failed', {
      reason: 'invalid-grant',
      cause: { headers: { authorization: 'Bearer secret-token' } },
    });
    const json = JSON.stringify(error);
    expect(json).not.toContain('secret-token');
    expect(JSON.parse(json)).toEqual({
      name: 'AuthError',
      code: 'AUTH_FAILED',
      message: 'refresh failed',
      reason: 'invalid-grant',
    });
  });

  it('includes retryAfterMs only when set', () => {
    expect(new RateLimitError('x', { retryAfterMs: 10 }).toJSON()).toMatchObject({
      retryAfterMs: 10,
    });
    expect(new RateLimitError('x').toJSON()).not.toHaveProperty('retryAfterMs');
  });
});
