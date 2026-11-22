import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { CliError } from '../errors.js';
import { describeDuration } from '../time.js';

export interface Loopback {
  /** `http://127.0.0.1:<port>/callback`, on a port the OS picked. */
  readonly redirectUri: string;
  /** The address the server is bound to: always `127.0.0.1`. */
  readonly address: string;
  /**
   * Arms the state check and waits for the one valid callback. A callback with another state
   * (or one that arrives before this is called) gets a 400 and the wait goes on.
   */
  expect(state: string): Promise<string>;
  close(): void;
}

const page = (title: string, text: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:sans-serif;margin:3rem"><h1>${title}</h1><p>${text}</p></body>`;

const DONE = page('You are signed in', 'You can close this tab and go back to the terminal.');
const CANCELLED = page('Sign-in cancelled', 'Nothing was saved. You can close this tab.');
const MISMATCH = page(
  "This sign-in link doesn't match",
  'Start again from the terminal with byos auth.',
);
const GONE = page('Already done', 'This sign-in already finished. You can close this tab.');

/**
 * A one-shot server on 127.0.0.1 (never 0.0.0.0) that catches Google's redirect. The pages are
 * static: nothing from the request is echoed back.
 */
export async function startLoopback(options: { timeoutMs: number }): Promise<Loopback> {
  let expected: string | undefined;
  let finished = false;
  let timer: NodeJS.Timeout | undefined;
  let hostHeader = '';
  let settle: { resolve: (code: string) => void; reject: (error: Error) => void } | undefined;

  const server = createServer((request, response) => {
    const send = (status: number, html: string) => {
      response.writeHead(status, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(html);
    };
    // A page on another origin that rebinds its DNS to 127.0.0.1 would arrive with its own Host.
    if (request.headers.host !== hostHeader) {
      send(400, MISMATCH);
      return;
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method !== 'GET' || url.pathname !== '/callback') {
      send(404, page('Not found', ''));
      return;
    }
    if (finished) {
      send(410, GONE);
      return;
    }
    if (expected === undefined || url.searchParams.get('state') !== expected) {
      send(400, MISMATCH);
      return;
    }
    if (url.searchParams.has('error')) {
      finished = true;
      send(200, CANCELLED);
      settle?.reject(new CliError('the Google sign-in was cancelled', 5, 'AUTH_FAILED'));
      return;
    }
    const code = url.searchParams.get('code');
    if (!code) {
      send(400, MISMATCH);
      return;
    }
    finished = true;
    send(200, DONE);
    settle?.resolve(code);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const bound = server.address() as AddressInfo;
  const { port } = bound;
  hostHeader = `127.0.0.1:${String(port)}`;

  const close = () => {
    if (timer) clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  };

  return {
    redirectUri: `http://127.0.0.1:${String(port)}/callback`,
    address: bound.address,
    expect(state) {
      expected = state;
      return new Promise<string>((resolve, reject) => {
        settle = { resolve, reject };
        timer = setTimeout(() => {
          finished = true;
          reject(
            new CliError(
              `timed out waiting for the Google sign-in (${describeDuration(options.timeoutMs)})`,
              5,
              'AUTH_FAILED',
            ),
          );
        }, options.timeoutMs);
      });
    },
    close,
  };
}
