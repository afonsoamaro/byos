import { AuthError, type FileStat, type StorageProvider } from '@byos/core';
import pLimit from 'p-limit';

import { describe, type Failure } from './upload.js';

/** The Google Drive provider can tell a trashed file from a missing one; the contract can't. */
export type VerifyProvider = StorageProvider & {
  inspect?: (id: string) => Promise<{ stat: FileStat; trashed: boolean } | undefined>;
};

export interface VerifyRow {
  readonly relPath: string;
  readonly sha256: string;
  readonly driveId: string;
}

export interface VerifyReport {
  readonly ok: number;
  /** Not in Drive at all. */
  readonly missing: readonly string[];
  /** In the Drive trash. */
  readonly trashed: readonly string[];
  /** In Drive, with a different (or no recorded) content hash. */
  readonly mismatch: readonly string[];
  /** Could not be checked: the provider failed. */
  readonly errors: readonly Failure[];
}

export const hasProblems = (report: VerifyReport): boolean =>
  report.missing.length + report.trashed.length + report.mismatch.length + report.errors.length > 0;

/**
 * Compares each manifest row with Drive by id, so a file the owner renamed or moved in Drive is
 * still found. Read-only: it only looks files up, and never repairs anything.
 */
export async function verifyBackup(options: {
  readonly rows: readonly VerifyRow[];
  readonly provider: VerifyProvider;
  readonly concurrency: number;
}): Promise<VerifyReport> {
  const { provider } = options;
  const limit = pLimit(options.concurrency);
  const missing: string[] = [];
  const trashed: string[] = [];
  const mismatch: string[] = [];
  const errors: Failure[] = [];
  let ok = 0;
  let authError: AuthError | undefined;

  const look = async (id: string): Promise<{ stat: FileStat; trashed: boolean } | undefined> => {
    if (provider.inspect) return provider.inspect(id);
    const stat = await provider.stat({ id });
    return stat === undefined ? undefined : { stat, trashed: false };
  };

  await Promise.all(
    options.rows.map((row) =>
      limit(async () => {
        if (authError) return;
        try {
          const found = await look(row.driveId);
          if (found === undefined) missing.push(row.relPath);
          else if (found.trashed) trashed.push(row.relPath);
          else if (found.stat.sha256 !== row.sha256) mismatch.push(row.relPath);
          else ok += 1;
        } catch (error) {
          if (error instanceof AuthError) authError ??= error;
          else errors.push({ relPath: row.relPath, ...describe(error) });
        }
      }),
    ),
  );
  // A refused sign-in makes every other answer meaningless: report it, not a partial result.
  if (authError) throw authError;
  const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    ok,
    missing: missing.sort(byPath),
    trashed: trashed.sort(byPath),
    mismatch: mismatch.sort(byPath),
    errors: errors.sort((a, b) => byPath(a.relPath, b.relPath)),
  };
}
