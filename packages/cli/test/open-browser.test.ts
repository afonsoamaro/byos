import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { openBrowser, type SpawnLike } from '../src/auth/open-browser.js';

const URL_OK = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&scope=a b&state=s&x=1&y=2';

function fakeSpawn(outcome: 'spawn' | 'error') {
  const calls: { command: string; args: readonly string[]; options: unknown }[] = [];
  const spawn: SpawnLike = (command, args, options) => {
    calls.push({ command, args, options });
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    queueMicrotask(() => child.emit(outcome, new Error('no such program')));
    return child;
  };
  return { spawn, calls };
}

describe('openBrowser', () => {
  it.each([
    ['win32', 'rundll32', ['url.dll,FileProtocolHandler', URL_OK]],
    ['darwin', 'open', [URL_OK]],
    ['linux', 'xdg-open', [URL_OK]],
  ] as const)(
    'on %s it runs %s with the URL as one argument, detached, with no shell',
    async (platform, command, args) => {
      const { spawn, calls } = fakeSpawn('spawn');
      expect(await openBrowser(URL_OK, platform, spawn)).toBe(true);
      expect(calls).toEqual([{ command, args, options: { stdio: 'ignore', detached: true } }]);
      expect(JSON.stringify(calls[0]?.options)).not.toContain('shell');
    },
  );

  it('resolves false when the program cannot start', async () => {
    expect(await openBrowser(URL_OK, 'linux', fakeSpawn('error').spawn)).toBe(false);
  });

  it.each([
    'http://accounts.google.com/x',
    'file:///etc/passwd',
    'javascript:alert(1)',
    '; rm -rf /',
  ])('refuses %j without spawning anything', async (url) => {
    const { spawn, calls } = fakeSpawn('spawn');
    expect(await openBrowser(url, 'linux', spawn)).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
