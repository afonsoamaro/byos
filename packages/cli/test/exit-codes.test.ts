import {
  AuthError,
  ConflictError,
  NotFoundError,
  PermissionError,
  ProviderError,
  QuotaExceededError,
  RateLimitError,
} from '@byos/core';
import { MemoryProvider } from '@byos/core/testing';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { main } from '../src/main.js';
import { cleanup, harness } from './helpers.js';

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('real fetch called');
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await cleanup();
});

// The documented table (docs/cli-output.md): this is the public API of `--json`.
const TABLE = [
  [new NotFoundError('no file at x'), 3, 'NOT_FOUND'],
  [new ConflictError('x already exists'), 4, 'CONFLICT'],
  [new AuthError('expired', { reason: 'invalid-grant' }), 5, 'AUTH_FAILED'],
  [new QuotaExceededError('your Google Drive is full'), 6, 'QUOTA_EXCEEDED'],
  [new RateLimitError('slow down'), 7, 'RATE_LIMITED'],
  [new PermissionError('refused'), 1, 'PERMISSION_DENIED'],
  [new ProviderError('upstream'), 1, 'PROVIDER_ERROR'],
] as const;

describe('each error class maps to its exit code and JSON code', () => {
  it.each(TABLE)('%s', async (error, exit, code) => {
    const memory = new MemoryProvider();
    memory.failNext('stat', error);
    const json = await harness({ memory });
    expect(await main(['stat', 'a.txt', '--json'], json.io)).toBe(exit);
    // --json: nothing on stdout, exactly one { code, message } line on stderr.
    expect(json.stdout()).toBe('');
    const lines = json.stderr().trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ code, message: error.message });

    const memory2 = new MemoryProvider();
    memory2.failNext('stat', error);
    const human = await harness({ memory: memory2 });
    expect(await main(['stat', 'a.txt'], human.io)).toBe(exit);
    expect(human.stderr()).toContain(`✗ ${code}: ${error.message}`);
    expect(human.stdout()).toBe('');
  });

  it('carries the reason of an auth error, so a consumer can tell what to do', async () => {
    const memory = new MemoryProvider();
    memory.failNext('stat', new AuthError('expired', { reason: 'testing-mode-expiry-suspected' }));
    const t = await harness({ memory });
    await main(['stat', 'a.txt', '--json'], t.io);
    expect(JSON.parse(t.stderr())).toEqual({
      code: 'AUTH_FAILED',
      message: 'expired',
      reason: 'testing-mode-expiry-suspected',
    });
  });

  it('a missing file is NOT_FOUND (3), and so is a missing id', async () => {
    const t = await harness({ memory: new MemoryProvider() });
    expect(await main(['stat', 'nope.txt'], t.io)).toBe(3);
    expect(await main(['stat', 'id:nope'], t.io)).toBe(3);
  });

  it('a usage mistake is exit 2 with a USAGE code', async () => {
    const t = await harness({ memory: new MemoryProvider() });
    expect(await main(['stat'], t.io)).toBe(2);
    expect(await main(['stat', 'a\\b'], t.io)).toBe(2);
    expect(await main(['put', '--json', 'no-such-local-file'], t.io)).toBe(2);
    expect(JSON.parse(t.stderr().trim().split('\n').at(-1) ?? '')).toMatchObject({ code: 'USAGE' });
  });

  it('without a sign-in and without an injected provider it is AUTH_FAILED (5)', async () => {
    const t = await harness();
    expect(await main(['ls', '--json'], t.io)).toBe(5);
    expect(JSON.parse(t.stderr())).toMatchObject({ code: 'AUTH_FAILED' });
  });

  it('put and rm go through the same table, with nothing on stdout under --json', async () => {
    for (const [argv, method] of [
      [['put', '__FILE__', '--json'], 'put'],
      [['rm', 'a.txt', '--json'], 'delete'],
    ] as const) {
      for (const [error, exit, code] of [TABLE[3], TABLE[1]]) {
        const memory = new MemoryProvider();
        const t = await harness({ memory });
        const file = join(t.dir, 'up.txt');
        await writeFile(file, 'data');
        await memory.put({
          parent: { path: '' },
          name: 'a.txt',
          body: new TextEncoder().encode('x'),
        });
        memory.failNext(method, error);
        expect(
          await main(
            argv.map((a) => (a === '__FILE__' ? file : a)),
            t.io,
          ),
        ).toBe(exit);
        expect(t.stdout()).toBe('');
        expect(JSON.parse(t.stderr().trim())).toMatchObject({ code, message: error.message });
      }
    }
  });
});
