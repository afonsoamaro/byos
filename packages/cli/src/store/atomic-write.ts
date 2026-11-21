import { randomBytes } from 'node:crypto';
import { chmod, link as fsLink, mkdir, open, rename, rm } from 'node:fs/promises';

export interface AtomicHooks {
  /** Runs after the temp file is written and before the rename: a test hook for "crashed here". */
  readonly beforeRename?: () => void | Promise<void>;
}

async function writeTemp(path: string, data: string | Uint8Array): Promise<string> {
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return temp;
}

/**
 * Writes `path` so a reader sees the old file or the whole new one, never half of it: a temp
 * file next to it (owner-only), flushed, then renamed over it.
 */
export async function writeFileAtomic(
  path: string,
  data: string | Uint8Array,
  hooks: AtomicHooks = {},
): Promise<void> {
  const temp = await writeTemp(path, data);
  try {
    await hooks.beforeRename?.();
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/**
 * Creates `path` with `data` only if it doesn't exist yet, and never exposes it half-written:
 * a temp file, then a hard link (which fails when the target exists). On a filesystem without
 * hard links (FAT, some network shares) it falls back to an exclusive create. Returns whether
 * this call created it.
 */
export async function writeFileExclusive(
  path: string,
  data: string | Uint8Array,
  link: (existing: string, target: string) => Promise<void> = fsLink,
): Promise<boolean> {
  const temp = await writeTemp(path, data);
  try {
    await link(temp, path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return false;
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'ENOSYS') {
      throw error;
    }
    return await createExclusive(path, data);
  } finally {
    await rm(temp, { force: true });
  }
}

async function createExclusive(path: string, data: string | Uint8Array): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return true;
}

/**
 * Creates a folder only its owner can use. `mkdir`'s mode applies to folders it creates, so one
 * that already existed (a `--config-dir` pointing at a 0755 folder) is tightened too.
 */
export async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(path, 0o700);
}
