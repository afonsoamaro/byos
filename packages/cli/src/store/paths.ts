import { posix, win32 } from 'node:path';

export interface PathEnv {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homedir: string;
}

const pathFor = (platform: NodeJS.Platform) => (platform === 'win32' ? win32 : posix);

/** Where the CLI keeps its config and tokens. `BYOS_CONFIG_DIR` (or `--config-dir`) wins. */
export function configDir({ platform, env, homedir }: PathEnv): string {
  if (env.BYOS_CONFIG_DIR) return env.BYOS_CONFIG_DIR;
  const path = pathFor(platform);
  if (platform === 'win32') {
    return path.join(env.APPDATA ?? path.join(homedir, 'AppData', 'Roaming'), 'byos');
  }
  if (platform === 'darwin') return path.join(homedir, 'Library', 'Application Support', 'byos');
  return path.join(env.XDG_CONFIG_HOME || path.join(homedir, '.config'), 'byos');
}

export function tokensDir(config: string, platform: NodeJS.Platform = process.platform): string {
  return pathFor(platform).join(config, 'tokens');
}

/** Where the CLI keeps data it can rebuild, such as backup manifests. `BYOS_DATA_DIR` wins. */
export function dataDir({ platform, env, homedir }: PathEnv): string {
  if (env.BYOS_DATA_DIR) return env.BYOS_DATA_DIR;
  const path = pathFor(platform);
  if (platform === 'win32') {
    return path.join(env.LOCALAPPDATA ?? path.join(homedir, 'AppData', 'Local'), 'byos');
  }
  if (platform === 'darwin') return path.join(homedir, 'Library', 'Application Support', 'byos');
  return path.join(env.XDG_DATA_HOME || path.join(homedir, '.local', 'share'), 'byos');
}
