import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CheckResult } from '../src/doctor/checks.js';
import { FIXES } from '../src/doctor/fixes.js';
import { main } from '../src/main.js';
import { cleanup, DAY, harness, NOW, type Harness } from './helpers.js';

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('real fetch called');
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await cleanup();
});

const DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file';

async function doctor(t: Harness, extra: string[] = ['--client', t.clientPath]) {
  const code = await main(['doctor', '--json', ...extra], t.io);
  const parsed = JSON.parse(t.stdout()) as { ok: boolean; checks: CheckResult[] };
  const byId = Object.fromEntries(parsed.checks.map((c) => [c.id, c]));
  // Whatever else happens, the Testing-mode reminder is there, with its fix.
  expect(byId['testing-mode']).toMatchObject({ status: 'warn', fix: FIXES.testingMode });
  return { code, ...parsed, byId };
}

describe('byos doctor', () => {
  it('passes every check with a valid client and token, and still reminds about Testing mode', async () => {
    const t = await harness();
    await t.seed({});
    const r = await doctor(t);
    expect(r.code).toBe(0);
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => c.id)).toEqual([
      'client-file',
      'token',
      'drive-api',
      'scopes',
      'testing-mode',
    ]);
    expect(r.checks.map((c) => c.status)).toEqual(['pass', 'pass', 'pass', 'pass', 'warn']);
    expect(r.byId['testing-mode']?.message).toContain("can't read the publishing status");
    expect(r.byId['testing-mode']?.message).toContain('2 days ago');
  });

  it('a refresh Google refuses 7 days after consent fails the token check with the publish fix', async () => {
    const t = await harness({ refresh: 'invalid_grant' });
    await t.seed({ expiresAt: NOW - 1000, consentedAt: NOW - 7 * DAY });
    const r = await doctor(t);
    expect(r.code).toBe(5);
    expect(r.byId.token).toMatchObject({ status: 'fail', fix: FIXES.publish });
    expect(r.byId['drive-api']?.status).toBe('skip');
  });

  it('an invalid_grant long after consent asks to sign in again instead', async () => {
    const t = await harness({ refresh: 'invalid_grant' });
    await t.seed({ expiresAt: NOW - 1000, consentedAt: NOW - 30 * DAY });
    const r = await doctor(t);
    expect(r.byId.token).toMatchObject({ status: 'fail', fix: FIXES.signIn });
  });

  it('a Drive API that is not enabled fails the api check with the enable step, exit 1', async () => {
    const t = await harness({ about: 'api-disabled' });
    await t.seed({});
    const r = await doctor(t);
    expect(r.code).toBe(1);
    expect(r.byId['drive-api']).toMatchObject({ status: 'fail', fix: FIXES.enableApi });
    expect(r.byId.token?.status).toBe('pass');
  });
});

describe('other failure modes', () => {
  it('a Drive that rejects the sign-in even after a refresh asks to sign in again', async () => {
    const t = await harness({ about: 'unauthorized' });
    await t.seed({});
    const r = await doctor(t);
    expect(r.code).toBe(1);
    expect(r.byId['drive-api']).toMatchObject({ status: 'fail', fix: FIXES.signIn });
  });

  it("a Drive that can't be reached suggests checking the network", async () => {
    const t = await harness({ about: 'network' });
    await t.seed({});
    const r = await doctor(t);
    expect(r.code).toBe(1);
    expect(r.byId['drive-api']).toMatchObject({ status: 'fail', fix: FIXES.network });
  });

  it("a refresh that can't reach Google fails the token check with the network fix", async () => {
    const t = await harness({ refresh: 'network' });
    await t.seed({ expiresAt: NOW - 1000 });
    const r = await doctor(t);
    expect(r.code).toBe(5);
    expect(r.byId.token).toMatchObject({ status: 'fail', fix: FIXES.network });
  });

  it("a stored sign-in that can't be read says to sign in again, not to check the network", async () => {
    const t = await harness();
    await t.seed({});
    const broken = {
      ...t.io,
      env: { ...t.io.env, BYOS_TOKEN_KEY: Buffer.alloc(32, 9).toString('base64') },
    };
    await main(['doctor', '--client', t.clientPath, '--json'], broken);
    const token = (JSON.parse(t.stdout()) as { checks: CheckResult[] }).checks.find(
      (c) => c.id === 'token',
    );
    expect(token).toMatchObject({ status: 'fail', fix: FIXES.signIn });
  });
});

describe('the skip chain', () => {
  it('no client at all: client-file fails, the rest skip, exit 5', async () => {
    const t = await harness();
    const r = await doctor(t, []);
    expect(r.code).toBe(5);
    expect(r.byId['client-file']).toMatchObject({ status: 'fail', fix: FIXES.noClient });
    expect(r.byId.token?.status).toBe('skip');
    expect(r.byId['drive-api']?.status).toBe('skip');
    expect(r.byId.scopes?.status).toBe('skip');
    expect(t.google.requests).toHaveLength(0);
  });

  it('a Web client fails with the Desktop fix', async () => {
    const t = await harness();
    const path = await t.writeClient({ web: { client_id: 'x' } });
    const r = await doctor(t, ['--client', path]);
    expect(r.code).toBe(5);
    expect(r.byId['client-file']).toMatchObject({ status: 'fail', fix: FIXES.wrongType });
  });

  it('a missing client file is reported with the setup step too', async () => {
    const t = await harness();
    const r = await doctor(t, ['--client', `${t.dir}/nope.json`]);
    expect(r.byId['client-file']).toMatchObject({ status: 'fail', fix: FIXES.noClient });
  });

  it('no token yet: the checks that need it skip with "run byos auth", exit 0', async () => {
    const t = await harness();
    const r = await doctor(t);
    expect(r.code).toBe(0);
    expect(r.byId['client-file']?.status).toBe('pass');
    expect(r.byId.token).toMatchObject({ status: 'skip', fix: FIXES.signIn });
    expect(r.byId['drive-api']?.status).toBe('skip');
    expect(r.byId['testing-mode']?.status).toBe('warn');
  });
});

describe('scopes', () => {
  it('extra scopes warn, name them and keep the exit code at 0', async () => {
    const t = await harness();
    await t.seed({ scopes: [DRIVE_FILE, 'https://www.googleapis.com/auth/drive'] });
    const r = await doctor(t);
    expect(r.code).toBe(0);
    expect(r.byId.scopes).toMatchObject({ status: 'warn', fix: FIXES.extraScopes });
    expect(r.byId.scopes?.message).toContain('drive');
  });

  it('drive.appdata is within what BYOS asks for', async () => {
    const t = await harness();
    await t.seed({ scopes: [DRIVE_FILE, 'https://www.googleapis.com/auth/drive.appdata'] });
    expect((await doctor(t)).byId.scopes?.status).toBe('pass');
  });
});

describe('output', () => {
  it('--json prints only { ok, checks } on stdout and nothing on stderr', async () => {
    const t = await harness();
    await t.seed({});
    await main(['doctor', '--client', t.clientPath, '--json'], t.io);
    expect(t.stderr()).toBe('');
    expect(Object.keys(JSON.parse(t.stdout()) as object).sort()).toEqual(['checks', 'ok']);
  });

  it('human output shows each check with its fix on the next line, and a summary', async () => {
    const t = await harness();
    await main(['doctor'], t.io);
    expect(t.stdout()).toContain(`✗ No client file is set up\n  fix: ${FIXES.noClient}`);
    expect(t.stdout()).toContain('- Needs the client file first');
    expect(t.stdout()).toMatch(/\n1 failed, 1 warning\n$/);
  });

  it('human output never prints a token or the client secret', async () => {
    const t = await harness();
    await t.seed({});
    await main(['doctor', '--client', t.clientPath], t.io);
    expect(t.stdout() + t.stderr()).not.toMatch(/ACCESS-secret|REFRESH-secret|CS-secret/);
  });
});
