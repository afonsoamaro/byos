import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { openManifest, type Manifest, type ManifestKey } from '../../src/backup/manifest.js';

const made: string[] = [];
const open: Manifest[] = [];

export async function tmp(prefix = 'byos-backup-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/** Writes `files` (relative path to content) under `root`, creating folders as needed. */
export async function write(
  root: string,
  files: Record<string, string | Uint8Array>,
): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}

export function manifestFor(dataDir: string, folder: string, extra: Partial<ManifestKey> = {}) {
  const manifest = openManifest({
    dataDir,
    folder,
    device: 'test-device',
    remoteRoot: 'BYOS Backup',
    ...extra,
  });
  open.push(manifest);
  return manifest;
}

export async function cleanupBackup(): Promise<void> {
  for (const manifest of open.splice(0)) {
    try {
      manifest.close();
    } catch {
      // already closed by the test
    }
  }
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}
