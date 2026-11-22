import type { FileRef } from '@byos/core';

import { CliError } from './errors.js';

/** A remote argument: `id:<fileId>`, or a POSIX path relative to the configured root. */
export function parseRemote(arg: string): FileRef {
  if (arg.startsWith('id:')) {
    const id = arg.slice(3);
    if (!id) throw new CliError('id: needs a file id (id:<fileId>)', 2, 'USAGE');
    return { id };
  }
  assertRemotePath(arg);
  return { path: arg };
}

/** Remote paths always use `/`; a backslash is most likely a Windows local path by mistake. */
export function assertRemotePath(path: string): void {
  if (path.includes('\\')) {
    throw new CliError(
      'remote paths use / (not \\); local paths are the only ones with \\',
      2,
      'USAGE',
    );
  }
}

export const segments = (path: string): string[] => path.split('/').filter((s) => s !== '');

export const joinRemote = (dir: string, name: string): string => [...segments(dir), name].join('/');

/** `a/b/c.txt` → `{ dir: 'a/b', name: 'c.txt' }`; the empty path has no name. */
export function splitRemote(path: string): { dir: string; name: string } {
  const parts = segments(path);
  const name = parts.pop() ?? '';
  return { dir: parts.join('/'), name };
}
