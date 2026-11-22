import { homedir } from 'node:os';

import { openBrowser } from './auth/open-browser.js';

/** Where output goes. `stream` is set for a real stream, so color follows the terminal. */
export interface Sink {
  readonly tty: boolean;
  readonly stream?: NodeJS.WriteStream;
  write(text: string): void;
}

/**
 * Everything the CLI takes from the outside world, so tests run `main()` in-process with
 * fakes: no network, no browser, no real config folder.
 */
export interface CliIO {
  readonly out: Sink;
  readonly err: Sink;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly homedir: string;
  readonly fetch: typeof fetch;
  /** Tries to open the page in a browser; false when it couldn't. The URL is printed anyway. */
  readonly openBrowser: (url: string) => Promise<boolean>;
  readonly now: () => number;
  /** How long `byos auth` waits for the redirect. Default 5 minutes. */
  readonly authTimeoutMs?: number;
}

function sink(stream: NodeJS.WriteStream): Sink {
  return {
    // `isTTY` is undefined (not false) when the stream is piped.
    tty: (stream as { isTTY?: boolean }).isTTY === true,
    stream,
    write: (text) => {
      stream.write(text);
    },
  };
}

export function realIO(): CliIO {
  return {
    out: sink(process.stdout),
    err: sink(process.stderr),
    env: process.env,
    platform: process.platform,
    homedir: homedir(),
    fetch: globalThis.fetch,
    openBrowser: (url) => openBrowser(url),
    now: Date.now,
  };
}
