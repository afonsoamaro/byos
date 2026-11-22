import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { posix, win32 } from 'node:path';

/** Local paths follow the platform the CLI runs on (backslashes and drive letters on Windows). */
export const pathApi = (platform: NodeJS.Platform) => (platform === 'win32' ? win32 : posix);

/** SHA-256 of a local file, read as a stream, as lowercase hex. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * A remote file name made safe to use as a local one. Drive allows names like `../x` or
 * `a\\b`, so separators never survive (and, on Windows, neither do the characters it refuses,
 * `:` included, which would write an NTFS alternate data stream). `.`, `..` and an empty name
 * have no safe form and return undefined.
 */
export function safeLocalName(name: string, platform: NodeJS.Platform): string | undefined {
  const forbidden = new Set(platform === 'win32' ? '\\/:*?"<>|' : '/');
  let safe = Array.from(name, (char) =>
    forbidden.has(char) || (char.codePointAt(0) ?? 0) < 32 ? '_' : char,
  ).join('');
  if (platform === 'win32') {
    // Windows drops trailing dots and spaces, and treats CON, NUL, COM1... (with any extension)
    // as devices rather than files.
    safe = safe.replace(/[. ]+$/, '');
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(safe)) safe = `_${safe}`;
  }
  return safe === '' || safe === '.' || safe === '..' ? undefined : safe;
}
