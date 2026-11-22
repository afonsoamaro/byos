import type { StorageProvider } from '@byos/core';
import { DriveProvider, TokenManager } from '@byos/drive';

import { loadDesktopClient, type DesktopClient } from './client-file.js';
import { CliError } from './errors.js';
import { ConfigFile } from './config.js';
import type { CliIO } from './io.js';
import { createOutput, type Output } from './output.js';
import { configDir } from './store/paths.js';
import { FileTokenStore } from './store/file-token-store.js';

/** The one token key the CLI uses: it signs in a single Google account per config folder. */
export const TOKEN_KEY = 'default';

export interface GlobalFlags {
  readonly configDir?: string;
  readonly json?: boolean;
}

export interface Context {
  readonly io: CliIO;
  readonly out: Output;
  readonly configDir: string;
  readonly config: ConfigFile;
  readonly store: FileTokenStore;
}

/** Builds what every command needs. Nothing here touches the network or the disk yet. */
export function openContext(io: CliIO, flags: GlobalFlags): Context {
  const env = flags.configDir ? { ...io.env, BYOS_CONFIG_DIR: flags.configDir } : io.env;
  const dir = configDir({ platform: io.platform, env, homedir: io.homedir });
  return {
    io,
    out: createOutput(io, { json: flags.json === true }),
    configDir: dir,
    config: new ConfigFile(dir),
    store: new FileTokenStore({ configDir: dir, env: io.env }),
  };
}

/** The Drive side for a Desktop client: a token manager over the CLI's store, and a provider. */
export function openProvider(ctx: Context, client: DesktopClient) {
  const tokens = new TokenManager({
    store: ctx.store,
    key: TOKEN_KEY,
    clientId: client.clientId,
    ...(client.clientSecret === undefined ? {} : { clientSecret: client.clientSecret }),
    fetch: ctx.io.fetch,
    now: ctx.io.now,
    ...(ctx.io.retry === undefined ? {} : { retry: ctx.io.retry }),
  });
  return {
    tokens,
    provider: new DriveProvider({
      tokens,
      fetch: ctx.io.fetch,
      ...(ctx.io.retry === undefined ? {} : { retry: ctx.io.retry }),
    }),
  };
}

/**
 * The provider the file commands use: the injected one in tests, otherwise Google Drive through
 * the client file `byos auth` saved. Without one there is no sign-in to speak of (exit 5).
 */
export async function openStorage(ctx: Context): Promise<StorageProvider> {
  if (ctx.io.createProvider) return ctx.io.createProvider();
  const { clientFile } = await ctx.config.read();
  if (!clientFile) {
    throw new CliError(
      'not signed in; run byos auth --client <path to the Desktop client JSON>',
      5,
      'AUTH_FAILED',
    );
  }
  return openProvider(ctx, await loadDesktopClient(clientFile)).provider;
}
