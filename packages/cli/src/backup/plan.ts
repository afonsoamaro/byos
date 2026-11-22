import { sha256File } from '../local.js';
import type { Manifest } from './manifest.js';
import type { PlanError, ScanEntry, ScanReport, Skipped } from './scan.js';

export type { PlanError };

export interface PlanItem {
  readonly relPath: string;
  readonly absPath: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly sha256: string;
  /** Set when the file is already in Drive: the upload is a new revision of this id. */
  readonly driveId?: string;
}

export interface Plan {
  readonly found: number;
  readonly unchanged: number;
  readonly toUpload: readonly PlanItem[];
  readonly bytes: number;
  readonly skipped: readonly Skipped[];
  readonly warnings: readonly string[];
  readonly errors: readonly PlanError[];
}

export interface PlanOptions {
  readonly entries: AsyncIterable<ScanEntry>;
  /** What the scan collected on the side (skips, warnings, unreadable folders). */
  readonly report: ScanReport;
  readonly manifest: Manifest;
  /** Streaming SHA-256 by default; injected by tests that count calls. */
  readonly hash?: (absPath: string) => Promise<string>;
  /** A dry run never writes to the manifest, not even a refreshed modification time. */
  readonly dryRun: boolean;
}

const code = (error: unknown): string =>
  (error as NodeJS.ErrnoException | undefined)?.code ?? 'UNKNOWN';

/**
 * Compares the scan with the manifest. Same size and modification time as the last upload means
 * unchanged, without reading the file. Anything else is hashed: the same content only refreshes
 * the stored time, different content (or a new file) goes in the plan. Files that are gone from
 * disk stay in the manifest and are never planned for deletion: the backup is additive.
 */
export async function planBackup(options: PlanOptions): Promise<Plan> {
  const hash = options.hash ?? sha256File;
  const toUpload: PlanItem[] = [];
  const warnings: string[] = [];
  const errors: PlanError[] = [];
  let found = 0;
  let unchanged = 0;
  let bytes = 0;

  for await (const entry of options.entries) {
    found += 1;
    const row = options.manifest.get(entry.relPath);
    if (row?.uploadedAt !== undefined && row.size === entry.size && row.mtimeMs === entry.mtimeMs) {
      unchanged += 1;
      continue;
    }
    let sha256: string;
    try {
      sha256 = await hash(entry.absPath);
    } catch (error) {
      if (code(error) === 'ENOENT') {
        found -= 1;
        warnings.push(`${entry.relPath} disappeared before it could be read, skipped`);
      } else {
        errors.push({
          relPath: entry.relPath,
          code: code(error),
          message: `${entry.relPath} can not be read (${code(error)})`,
        });
      }
      continue;
    }
    if (row?.uploadedAt !== undefined && row.sha256 === sha256 && row.size === entry.size) {
      unchanged += 1;
      if (!options.dryRun) options.manifest.touchMtime(entry.relPath, entry.mtimeMs);
      continue;
    }
    bytes += entry.size;
    toUpload.push({
      relPath: entry.relPath,
      absPath: entry.absPath,
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      sha256,
      ...(row?.driveId === undefined ? {} : { driveId: row.driveId }),
    });
  }

  return {
    found,
    unchanged,
    toUpload,
    bytes,
    // The scan fills its report while `entries` is consumed, so it is read only now.
    skipped: options.report.skipped,
    warnings: [...options.report.warnings, ...warnings],
    errors: [...options.report.errors, ...errors],
  };
}
