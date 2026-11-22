import { lstat, opendir } from 'node:fs/promises';
import { join } from 'node:path';

import picomatch from 'picomatch';

export interface ScanEntry {
  /** POSIX, NFC-normalized, relative to the scanned folder: the manifest key. */
  readonly relPath: string;
  /** Where the file really is, as the file system spells it. */
  readonly absPath: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export type SkipReason = 'system' | 'hidden' | 'symlink' | 'excluded' | 'not-regular' | 'duplicate';

export interface PlanError {
  readonly relPath: string;
  readonly code: string;
  readonly message: string;
}

export interface Skipped {
  readonly relPath: string;
  readonly reason: SkipReason;
}

/** What a scan notes on the side; filled while the entries are consumed. */
export interface ScanReport {
  readonly skipped: Skipped[];
  readonly warnings: string[];
  readonly errors: PlanError[];
}

export const createReport = (): ScanReport => ({ skipped: [], warnings: [], errors: [] });

export interface ScanOptions {
  /** Globs matched against the POSIX relative path (dot files included). */
  readonly exclude?: readonly string[];
}

// Windows and macOS write these on their own. Compared in lowercase: the file systems that
// create them ignore case. The Windows "hidden" attribute can't be read from Node without a
// native call, so only these names and dot-prefixed names count as hidden.
const SYSTEM_NAMES = new Set(['thumbs.db', 'desktop.ini', '.ds_store']);

const errorCode = (error: unknown): string =>
  (error as NodeJS.ErrnoException | undefined)?.code ?? 'UNKNOWN';

/**
 * Walks `root` and yields every regular file that should be backed up. Symlinks are never
 * followed (a backup can't leave the chosen folder) and are reported as skipped. Problems with
 * one file or folder go to `report` and the walk continues.
 */
export async function* scan(
  root: string,
  options: ScanOptions,
  report: ScanReport,
): AsyncGenerator<ScanEntry> {
  const excluded = (options.exclude ?? []).map((glob) => picomatch(glob, { dot: true }));
  const isExcluded = (relPath: string): boolean => excluded.some((match) => match(relPath));
  const seen = new Map<string, string>();

  function skip(relPath: string, name: string, isDir: boolean): boolean {
    const lower = name.toLowerCase();
    if (SYSTEM_NAMES.has(lower)) report.skipped.push({ relPath, reason: 'system' });
    else if (name.startsWith('.')) report.skipped.push({ relPath, reason: 'hidden' });
    else if (isExcluded(relPath) || (isDir && isExcluded(`${relPath}/`))) {
      report.skipped.push({ relPath, reason: 'excluded' });
    } else return false;
    return true;
  }

  async function* walk(dir: string, prefix: string): AsyncGenerator<ScanEntry> {
    let handle;
    try {
      handle = await opendir(dir);
    } catch (error) {
      report.errors.push({
        relPath: prefix === '' ? '.' : prefix,
        code: errorCode(error),
        message: `${prefix === '' ? dir : prefix} can not be opened (${errorCode(error)})`,
      });
      return;
    }
    const subdirs: [string, string][] = [];
    for await (const dirent of handle) {
      // The same NFC rule as normalizePath in @byos/core, applied to one name: that function
      // splits a whole path and refuses `.` and `..`, which a directory entry never is.
      const name = dirent.name.normalize('NFC');
      const relPath = prefix === '' ? name : `${prefix}/${name}`;
      const absPath = join(dir, dirent.name);
      if (dirent.isSymbolicLink()) {
        report.skipped.push({ relPath, reason: 'symlink' });
      } else if (dirent.isDirectory()) {
        if (!skip(relPath, name, true)) subdirs.push([absPath, relPath]);
      } else if (dirent.isFile()) {
        if (skip(relPath, name, false)) continue;
        const known = seen.get(relPath);
        if (known !== undefined) {
          report.skipped.push({ relPath, reason: 'duplicate' });
          report.warnings.push(
            `${relPath} appears twice with the same name after normalization, the second one is skipped`,
          );
          continue;
        }
        const lower = relPath.toLowerCase();
        const clash = seen.get(`\0${lower}`);
        if (clash !== undefined) {
          report.warnings.push(
            `${clash} and ${relPath} differ only by case; both are backed up, but a Windows or macOS restore would merge them`,
          );
        } else seen.set(`\0${lower}`, relPath);
        seen.set(relPath, absPath);
        let info;
        try {
          info = await lstat(absPath);
        } catch (error) {
          if (errorCode(error) === 'ENOENT') {
            report.warnings.push(`${relPath} disappeared during the scan, skipped`);
          } else {
            report.errors.push({
              relPath,
              code: errorCode(error),
              message: `${relPath} can not be read (${errorCode(error)})`,
            });
          }
          continue;
        }
        yield { relPath, absPath, size: info.size, mtimeMs: info.mtimeMs };
      } else {
        report.skipped.push({ relPath, reason: 'not-regular' });
      }
    }
    for (const [absPath, relPath] of subdirs) yield* walk(absPath, relPath);
  }

  yield* walk(root, '');
}
