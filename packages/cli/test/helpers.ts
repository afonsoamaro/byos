import { mkdtempSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { StorageProvider, StoredToken } from '@byos/core';

import type { CliIO, Sink } from '../src/io.js';
import { FileTokenStore } from '../src/store/file-token-store.js';

// Captured before any test stubs the global: the simulated browser really reaches the loopback.
export const realFetch = globalThis.fetch;

export const NOW = Date.UTC(2026, 10, 21, 12, 0, 0);
export const DAY = 24 * 60 * 60 * 1000;
export const TOKEN_ENV_KEY = Buffer.alloc(32, 5).toString('base64');

const dirs: string[] = [];

export async function cleanup(): Promise<void> {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

function capture(): Sink & { text(): string; bytes(): Buffer } {
  let buffer = '';
  const raw: Buffer[] = [];
  return {
    tty: false,
    write: (text) => {
      buffer += text;
    },
    writeBytes: (bytes) => {
      raw.push(Buffer.from(bytes));
    },
    text: () => buffer,
    bytes: () => Buffer.concat(raw),
  };
}

export type Browser = 'consent' | 'denied' | 'bad-state-then-consent' | 'none';

export interface FakeGoogleOptions {
  readonly revokeStatus?: number;
  /** A refresh the token endpoint refuses with invalid_grant (a revoked or expired token). */
  readonly refresh?: 'ok' | 'invalid_grant' | 'network';
  /** `about.get` when the Drive API isn't enabled in the project (403 accessNotConfigured). */
  readonly about?: 'ok' | 'api-disabled' | 'unauthorized' | 'network';
}

export interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly body: Record<string, string>;
  readonly authorization?: string;
}

/** Routes the three Google hosts the CLI talks to, and records what it was sent. */
export function fakeGoogle(options: FakeGoogleOptions = {}) {
  const requests: Recorded[] = [];
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const headers = new Headers(init?.headers);
    const body = Object.fromEntries(
      new URLSearchParams(typeof init?.body === 'string' ? init.body : ''),
    );
    const authorization = headers.get('authorization') ?? undefined;
    requests.push({
      url: url.href,
      method: init?.method ?? 'GET',
      body,
      ...(authorization === undefined ? {} : { authorization }),
    });
    if (
      url.host === 'oauth2.googleapis.com' &&
      url.pathname === '/token' &&
      body.grant_type === 'refresh_token' &&
      options.refresh === 'network'
    ) {
      return Promise.reject(new TypeError('fetch failed'));
    }
    if (
      url.host === 'www.googleapis.com' &&
      url.pathname === '/drive/v3/about' &&
      options.about === 'network'
    ) {
      return Promise.reject(new TypeError('fetch failed'));
    }
    if (
      url.host === 'www.googleapis.com' &&
      url.pathname === '/drive/v3/about' &&
      options.about === 'unauthorized'
    ) {
      return Promise.resolve(
        reply(401, { error: { code: 401, errors: [{ reason: 'authError' }] } }),
      );
    }
    if (
      url.host === 'oauth2.googleapis.com' &&
      url.pathname === '/token' &&
      body.grant_type === 'refresh_token' &&
      options.refresh === 'invalid_grant'
    ) {
      return Promise.resolve(
        reply(400, { error: 'invalid_grant', error_description: 'Token revoked' }),
      );
    }
    if (url.host === 'oauth2.googleapis.com' && url.pathname === '/token') {
      return Promise.resolve(
        reply(200, {
          access_token: body.grant_type === 'refresh_token' ? 'ACCESS-secret-2' : 'ACCESS-secret-1',
          ...(body.grant_type === 'refresh_token' ? {} : { refresh_token: 'REFRESH-secret-1' }),
          expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/drive.file',
          token_type: 'Bearer',
        }),
      );
    }
    if (url.host === 'oauth2.googleapis.com' && url.pathname === '/revoke') {
      return Promise.resolve(reply(options.revokeStatus ?? 200, {}));
    }
    if (
      url.host === 'www.googleapis.com' &&
      url.pathname === '/drive/v3/about' &&
      options.about === 'api-disabled'
    ) {
      return Promise.resolve(
        reply(403, {
          error: {
            code: 403,
            message: 'Drive API has not been used',
            errors: [{ reason: 'accessNotConfigured' }],
          },
        }),
      );
    }
    if (url.host === 'www.googleapis.com' && url.pathname === '/drive/v3/about') {
      return Promise.resolve(
        reply(200, { user: { emailAddress: 'owner@example.com', displayName: 'Owner' } }),
      );
    }
    return Promise.resolve(reply(404, { error: { code: 404 } }));
  };
  return { fetch, requests };
}

export interface Harness {
  readonly io: CliIO;
  readonly dir: string;
  readonly google: ReturnType<typeof fakeGoogle>;
  /** Every page the loopback served to the simulated browser. */
  readonly pages: string[];
  readonly opened: string[];
  readonly clientPath: string;
  /** Presses Ctrl+C: calls every handler a command registered through `onInterrupt`. */
  interrupt(): void;
  stdout(): string;
  stdoutBytes(): Buffer;
  stderr(): string;
  store(): FileTokenStore;
  seed(token: Partial<StoredToken>): Promise<StoredToken>;
  writeClient(content: unknown): Promise<string>;
}

export async function harness(
  options: {
    browser?: Browser;
    authTimeoutMs?: number;
    revokeStatus?: number;
    refresh?: 'ok' | 'invalid_grant' | 'network';
    about?: 'ok' | 'api-disabled' | 'unauthorized' | 'network';
    /** Run the file commands against this provider instead of Google Drive. */
    memory?: StorageProvider;
  } = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'byos-cli-'));
  dirs.push(dir);
  const out = capture();
  const err = capture();
  const google = fakeGoogle({
    ...(options.revokeStatus === undefined ? {} : { revokeStatus: options.revokeStatus }),
    ...(options.refresh === undefined ? {} : { refresh: options.refresh }),
    ...(options.about === undefined ? {} : { about: options.about }),
  });
  const pages: string[] = [];
  const opened: string[] = [];
  const browser = options.browser ?? 'consent';
  const env = { BYOS_CONFIG_DIR: dir, BYOS_TOKEN_KEY: TOKEN_ENV_KEY };

  const visit = async (redirect: string, query: string) => {
    const response = await realFetch(`${redirect}?${query}`);
    pages.push(await response.text());
  };
  const interrupts = new Set<() => void>();
  const io: CliIO = {
    out,
    err,
    onInterrupt: (handler) => {
      interrupts.add(handler);
      return () => {
        interrupts.delete(handler);
      };
    },
    env,
    platform: 'linux',
    homedir: dir,
    fetch: google.fetch,
    now: () => NOW,
    authTimeoutMs: options.authTimeoutMs ?? 10_000,
    retry: { random: () => 0 },
    ...(options.memory === undefined
      ? {}
      : { createProvider: () => options.memory as StorageProvider }),
    openBrowser: (url) => {
      opened.push(url);
      const parsed = new URL(url);
      const redirect = parsed.searchParams.get('redirect_uri') ?? '';
      const state = parsed.searchParams.get('state') ?? '';
      setTimeout(() => {
        const work =
          browser === 'consent'
            ? visit(redirect, `code=CODE-secret&state=${state}`)
            : browser === 'denied'
              ? visit(redirect, `error=access_denied&state=${state}`)
              : browser === 'bad-state-then-consent'
                ? visit(redirect, 'code=CODE-evil&state=wrong').then(() =>
                    visit(redirect, `code=CODE-secret&state=${state}`),
                  )
                : Promise.resolve();
        void work;
      }, 0);
      return Promise.resolve(true);
    },
  };

  const clientPath = join(dir, 'client.json');
  const writeClient = async (content: unknown) => {
    await writeFile(clientPath, JSON.stringify(content));
    return clientPath;
  };
  await writeClient({ installed: { client_id: 'client-123', client_secret: 'CS-secret' } });

  const store = () => new FileTokenStore({ configDir: dir, env });
  return {
    io,
    dir,
    google,
    pages,
    opened,
    clientPath,
    interrupt: () => {
      for (const handler of [...interrupts]) handler();
    },
    stdout: () => out.text(),
    stdoutBytes: () => out.bytes(),
    stderr: () => err.text(),
    store,
    async seed(token) {
      const full: StoredToken = {
        accessToken: 'ACCESS-secret-seed',
        refreshToken: 'REFRESH-secret-seed',
        expiresAt: NOW + 3_600_000,
        scopes: ['https://www.googleapis.com/auth/drive.file'],
        consentedAt: NOW - 2 * DAY,
        ...token,
      };
      await store().save('default', full);
      return full;
    },
    writeClient,
  };
}
