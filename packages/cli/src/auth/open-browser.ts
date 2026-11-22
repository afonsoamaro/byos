import { spawn as nodeSpawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';

/**
 * Opens `url` in the default browser. `spawn` without a shell, with the URL as one argument,
 * so nothing in it can be read as a command. Resolves false when it couldn't start.
 */
export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: { stdio: 'ignore'; detached: true },
) => EventEmitter & { unref(): void };

export function openBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform,
  spawn: SpawnLike = nodeSpawn,
): Promise<boolean> {
  if (!url.startsWith('https://')) return Promise.resolve(false);
  const [command, args] =
    platform === 'win32'
      ? (['rundll32', ['url.dll,FileProtocolHandler', url]] as const)
      : platform === 'darwin'
        ? (['open', [url]] as const)
        : (['xdg-open', [url]] as const);
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.once('error', () => {
      resolve(false);
    });
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}
