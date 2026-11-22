import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { main } from '../src/main.js';
import { cleanup, DAY, harness, NOW, TOKEN_ENV_KEY } from './helpers.js';

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('real fetch called');
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await cleanup();
});

describe('byos auth', () => {
  it('signs in through the loopback, saves the token and shows the account', async () => {
    const t = await harness();
    const code = await main(['auth', '--client', t.clientPath], t.io);
    expect(t.stderr()).toBe('');
    expect(code).toBe(0);
    expect(t.stdout()).toContain('Connected as owner@example.com');
    expect(t.stdout()).toMatch(/scopes\s+drive\.file/);
    expect(t.stdout()).toContain('Opening your browser to sign in to Google');
    expect(await t.store().load('default')).toMatchObject({
      accessToken: 'ACCESS-secret-1',
      refreshToken: 'REFRESH-secret-1',
      consentedAt: NOW,
    });
    const config = JSON.parse(await readFile(join(t.dir, 'config.json'), 'utf8')) as {
      clientFile: string;
      account: { email: string };
    };
    expect(config.account.email).toBe('owner@example.com');
    expect(config.clientFile).toBe(t.clientPath);
  });

  it('sends the code exchange with PKCE, the client secret and the loopback redirect', async () => {
    const t = await harness();
    await main(['auth', '--client', t.clientPath], t.io);
    const exchange = t.google.requests.find((r) => r.url.endsWith('/token'));
    expect(exchange?.body).toMatchObject({
      grant_type: 'authorization_code',
      code: 'CODE-secret',
      client_id: 'client-123',
      client_secret: 'CS-secret',
    });
    expect(exchange?.body.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(exchange?.body.redirect_uri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  });

  it('keeps waiting after a callback with a bad state', async () => {
    const t = await harness({ browser: 'bad-state-then-consent' });
    expect(await main(['auth', '--client', t.clientPath], t.io)).toBe(0);
    expect(t.pages).toHaveLength(2);
    expect(t.pages[0]).toContain("doesn't match");
  });

  it('asks for consent on a first sign-in and not on a reconnect', async () => {
    const first = await harness();
    await main(['auth', '--client', first.clientPath], first.io);
    expect(new URL(first.opened[0] ?? '').searchParams.get('prompt')).toBe('consent');

    const again = await harness();
    await again.seed({});
    await main(['auth', '--client', again.clientPath], again.io);
    expect(new URL(again.opened[0] ?? '').searchParams.has('prompt')).toBe(false);
  });

  it('keeps the stored refresh token when a reconnect brings none', async () => {
    const t = await harness();
    await t.seed({ refreshToken: 'REFRESH-secret-old' });
    // The fake's code exchange always includes a refresh token; drop it for this reply.
    const original = t.io.fetch;
    const io = {
      ...t.io,
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const response = await original(input, init);
        const href =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (href.endsWith('/token')) {
          const body = (await response.json()) as Record<string, unknown>;
          delete body.refresh_token;
          return new Response(JSON.stringify(body), { status: 200 });
        }
        return response;
      },
    };
    expect(await main(['auth', '--client', t.clientPath], io)).toBe(0);
    expect((await t.store().load('default'))?.refreshToken).toBe('REFRESH-secret-old');
  });

  it('under --json the sign-in URL still reaches the person, as one plain line on stderr', async () => {
    const t = await harness();
    expect(await main(['auth', '--client', t.clientPath, '--json'], t.io)).toBe(0);
    expect(t.stderr().trim()).toBe(t.opened[0]);
    expect(JSON.parse(t.stdout())).toEqual({
      account: 'owner@example.com',
      scopes: ['https://www.googleapis.com/auth/drive.file'],
    });
  });

  it('a client file with both web and installed blocks is refused too', async () => {
    const t = await harness();
    const path = await t.writeClient({
      installed: { client_id: 'x' },
      web: { client_id: 'y' },
    });
    expect(await main(['auth', '--client', path], t.io)).toBe(5);
    expect(t.stderr()).toContain('installed, web');
  });

  it('an installed block without a client_id is a usage error, not a wrong-type error', async () => {
    const t = await harness();
    const path = await t.writeClient({ installed: { client_secret: 'CS-secret' } });
    expect(await main(['auth', '--client', path], t.io)).toBe(2);
    expect(t.stderr()).toContain('without a client_id');
    expect(t.stderr()).not.toContain('CS-secret');
  });

  it('a Web client JSON is refused with a pointer to doctor', async () => {
    const t = await harness();
    const path = await t.writeClient({ web: { client_id: 'x', client_secret: 'y' } });
    expect(await main(['auth', '--client', path], t.io)).toBe(5);
    expect(t.stderr()).toMatch(/not a Desktop app client.*byos doctor/s);
    expect(t.opened).toHaveLength(0);
  });

  it('a missing client file is a usage error, and so is no client at all', async () => {
    const t = await harness();
    expect(await main(['auth', '--client', join(t.dir, 'nope.json')], t.io)).toBe(2);
    expect(await main(['auth'], t.io)).toBe(2);
    expect(t.stderr()).toContain('USAGE');
  });

  it('a denied consent ends with a clean message and exit 5', async () => {
    const t = await harness({ browser: 'denied' });
    expect(await main(['auth', '--client', t.clientPath], t.io)).toBe(5);
    expect(t.stderr()).toContain('the Google sign-in was cancelled');
    expect(await t.store().load('default')).toBeUndefined();
  });

  it('times out with a clear message', async () => {
    const t = await harness({ browser: 'none', authTimeoutMs: 80 });
    expect(await main(['auth', '--client', t.clientPath], t.io)).toBe(5);
    expect(t.stderr()).toContain('timed out waiting for the Google sign-in');
  });
});

describe('byos auth status', () => {
  it('shows account, scopes, consent date and token expiry, without a warning when recent', async () => {
    const t = await harness();
    await main(['auth', '--client', t.clientPath], t.io);
    const status = await harness();
    await status.seed({ consentedAt: NOW - 2 * DAY });
    await status.writeClient({});
    expect(await main(['auth', 'status'], status.io)).toBe(0);
    expect(status.stdout()).toMatch(/consented\s+2026-11-19 \(2 days ago\)/);
    expect(status.stdout()).toMatch(/scopes\s+drive\.file/);
    expect(status.stderr()).toBe('');
  });

  it('warns about Testing mode when the consent is older than 6 days', async () => {
    const t = await harness();
    await t.seed({ consentedAt: NOW - 7 * DAY });
    expect(await main(['auth', 'status'], t.io)).toBe(0);
    expect(t.stderr()).toMatch(/^\n! Consent is 7 days old/);
    expect(t.stdout()).not.toMatch(/\n\n$/);
    expect(t.stderr()).toContain('Publish the app');
  });

  it('--json prints one document with the testing-mode flag', async () => {
    const t = await harness();
    await t.seed({ consentedAt: NOW - 7 * DAY });
    expect(await main(['auth', 'status', '--json'], t.io)).toBe(0);
    expect(t.stderr()).toBe('');
    const doc = JSON.parse(t.stdout()) as Record<string, unknown>;
    expect(doc).toMatchObject({
      scopes: ['https://www.googleapis.com/auth/drive.file'],
      consentedAt: new Date(NOW - 7 * DAY).toISOString(),
      testingModeWarning: true,
    });
    expect(Object.keys(doc).sort()).toEqual([
      'account',
      'consentedAt',
      'expiresAt',
      'scopes',
      'testingModeWarning',
    ]);
  });

  it('not signed in is exit 5', async () => {
    const t = await harness();
    expect(await main(['auth', 'status'], t.io)).toBe(5);
    expect(t.stderr()).toContain('not signed in');
  });
});

describe('byos auth logout', () => {
  it('revokes the refresh token and clears the store and the account', async () => {
    const t = await harness();
    await main(['auth', '--client', t.clientPath], t.io);
    expect(await main(['auth', 'logout'], t.io)).toBe(0);
    const revoke = t.google.requests.find((r) => r.url.endsWith('/revoke'));
    expect(revoke?.body).toEqual({ token: 'REFRESH-secret-1' });
    expect(await t.store().load('default')).toBeUndefined();
    const config = JSON.parse(await readFile(join(t.dir, 'config.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(config).not.toHaveProperty('account');
  });

  it('still signs out locally when Google refuses the revoke, with a warning', async () => {
    const t = await harness({ revokeStatus: 400 });
    await t.seed({});
    expect(await main(['auth', 'logout'], t.io)).toBe(0);
    expect(t.stderr()).toContain("Couldn't revoke");
    expect(await t.store().load('default')).toBeUndefined();
  });

  it('removes a sign-in that cannot be read, instead of failing', async () => {
    const t = await harness();
    await t.seed({});
    const broken = {
      ...t.io,
      env: { ...t.io.env, BYOS_TOKEN_KEY: Buffer.alloc(32, 9).toString('base64') },
    };
    expect(await main(['auth', 'logout'], broken)).toBe(0);
    expect(await readdir(join(t.dir, 'tokens'))).toEqual([]);
  });
});

describe('secrets', () => {
  it('never reach the screen, the pages, an error or the config, across the whole flow', async () => {
    const full = await harness();
    await main(['auth', '--client', full.clientPath], full.io);
    await main(['auth', 'status', '--json'], full.io);
    await main(['auth', 'logout'], full.io);

    const denied = await harness({ browser: 'denied' });
    await main(['auth', '--client', denied.clientPath], denied.io);
    const web = await harness();
    await main(
      [
        'auth',
        '--client',
        await web.writeClient({ web: { client_id: 'x', client_secret: 'CS-secret' } }),
      ],
      web.io,
    );

    // Control: the secrets did pass through here (the exchange saw them, the token was stored).
    const exchange = full.google.requests.find((r) => r.url.endsWith('/token'));
    expect(exchange?.body.code).toBe('CODE-secret');
    expect(exchange?.body.client_secret).toBe('CS-secret');
    expect(full.pages.length).toBeGreaterThan(0);

    const verifier = exchange?.body.code_verifier ?? '';
    const everything = [
      ...[full, denied, web].flatMap((h) => [h.stdout(), h.stderr(), ...h.pages]),
      await readFile(join(full.dir, 'config.json'), 'utf8').catch(() => ''),
    ].join('\n');
    for (const secret of [
      'CODE-secret',
      'ACCESS-secret-1',
      'REFRESH-secret-1',
      'CS-secret',
      TOKEN_ENV_KEY,
      verifier,
    ]) {
      expect(everything).not.toContain(secret);
    }
  });
});
