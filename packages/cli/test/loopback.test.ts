import { request } from 'node:http';
import { networkInterfaces } from 'node:os';
import { connect } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { startLoopback, type Loopback } from '../src/auth/loopback.js';
import { CliError } from '../src/errors.js';
import { realFetch } from './helpers.js';

let open: Loopback | undefined;

afterEach(() => {
  open?.close();
  open = undefined;
});

async function start(timeoutMs = 5000) {
  open = await startLoopback({ timeoutMs });
  return open;
}

const get = (url: string) => realFetch(url);

describe('startLoopback', () => {
  it('listens on 127.0.0.1 on a port the OS picked, and nowhere else', async () => {
    const loopback = await start();
    expect(loopback.address).toBe('127.0.0.1');
    expect(loopback.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    const port = Number(new URL(loopback.redirectUri).port);
    const external = Object.values(networkInterfaces())
      .flat()
      .find((address) => address?.family === 'IPv4' && !address.internal);
    if (!external) return; // a machine with no other interface: nothing to probe
    const refused = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: external.address, port });
      socket.once('connect', () => {
        socket.destroy();
        resolve(false);
      });
      socket.once('error', () => {
        resolve(true);
      });
    });
    expect(refused).toBe(true);
  });

  it('resolves the code of the one valid callback, and rejects a wrong state first', async () => {
    const loopback = await start();
    const code = loopback.expect('STATE-1');
    const bad = await get(`${loopback.redirectUri}?code=CODE-evil&state=other`);
    expect(bad.status).toBe(400);
    const good = await get(`${loopback.redirectUri}?code=CODE-1&state=STATE-1`);
    expect(good.status).toBe(200);
    expect(await code).toBe('CODE-1');
  });

  it('answers 410 to a second valid callback', async () => {
    const loopback = await start();
    const code = loopback.expect('S');
    await get(`${loopback.redirectUri}?code=ONE&state=S`);
    await code;
    expect((await get(`${loopback.redirectUri}?code=TWO&state=S`)).status).toBe(410);
  });

  it('refuses a callback that arrives before the state is armed', async () => {
    const loopback = await start();
    expect((await get(`${loopback.redirectUri}?code=EARLY&state=S`)).status).toBe(400);
  });

  it('turns a denial into a CliError (exit 5), but only with the right state', async () => {
    const loopback = await start();
    const code = loopback.expect('S');
    const settled = code.then(
      () => undefined,
      (error: unknown) => error,
    );
    await get(`${loopback.redirectUri}?error=access_denied&state=forged`);
    await get(`${loopback.redirectUri}?error=access_denied&state=S`);
    const error = await settled;
    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({ exitCode: 5, code: 'AUTH_FAILED' });
  });

  it('times out with a clear message', async () => {
    const loopback = await start(50);
    await expect(loopback.expect('S')).rejects.toThrow(/timed out waiting for the Google sign-in/);
  });

  it('serves 404 for anything but the callback', async () => {
    const loopback = await start();
    expect((await get(new URL('/other', loopback.redirectUri).href)).status).toBe(404);
  });

  it('never echoes the code or the state in a page', async () => {
    const loopback = await start();
    const code = loopback.expect('STATE-SECRET');
    const pages: string[] = [];
    for (const query of ['code=X&state=nope', 'code=CODE-SECRET&state=STATE-SECRET']) {
      pages.push(await (await get(`${loopback.redirectUri}?${query}`)).text());
    }
    pages.push(await (await get(`${loopback.redirectUri}?code=Y&state=STATE-SECRET`)).text());
    await code;
    const all = pages.join('\n');
    expect(all).not.toMatch(/CODE-SECRET|STATE-SECRET|nope/);
    expect(pages.length).toBe(3);
  });

  it('refuses a request whose Host is not the loopback (DNS rebinding)', async () => {
    const loopback = await start();
    const code = loopback.expect('S');
    const status = await new Promise<number>((resolve, reject) => {
      const { port } = new URL(loopback.redirectUri);
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path: '/callback?code=C&state=S',
          headers: { host: 'evil.example' },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      req.once('error', reject);
      req.end();
    });
    expect(status).toBe(400);
    // The real callback still works afterwards: the forged one didn't count.
    await get(`${loopback.redirectUri}?code=REAL&state=S`);
    expect(await code).toBe('REAL');
  });
});
