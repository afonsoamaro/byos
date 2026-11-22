import { createHash } from 'node:crypto';
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface ManifestKey {
  /** The absolute local folder being backed up. */
  readonly folder: string;
  readonly device: string;
  readonly remoteRoot: string;
}

export interface FileRow {
  readonly relPath: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly sha256: string;
  readonly driveId: string | undefined;
  readonly uploadedAt: number | undefined;
}

export interface SessionRow {
  readonly relPath: string;
  readonly sessionUri: string;
  readonly offset: number;
  readonly size: number;
  readonly sha256: string;
  readonly startedAt: number;
}

/**
 * Forward migrations: `MIGRATIONS[i]` takes the schema from version i to i + 1. A database
 * whose `schema_version` is lower gets the missing ones, each in its own transaction. Never
 * edit one that shipped: add the next.
 */
export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE files (
     rel_path TEXT PRIMARY KEY,
     size INTEGER NOT NULL,
     mtime_ms REAL NOT NULL,
     sha256 TEXT NOT NULL,
     drive_id TEXT,
     uploaded_at INTEGER
   );
   CREATE TABLE folders (rel_path TEXT PRIMARY KEY, drive_id TEXT NOT NULL);
   CREATE TABLE sessions (
     rel_path TEXT PRIMARY KEY,
     session_uri TEXT NOT NULL,
     offset INTEGER NOT NULL,
     size INTEGER NOT NULL,
     sha256 TEXT NOT NULL,
     started_at INTEGER NOT NULL
   );`,
];

export interface OpenManifestOptions extends ManifestKey {
  readonly dataDir: string;
  /**
   * False for a dry run: when there is no manifest yet, an in-memory one stands in and no file
   * is created. An existing manifest is opened as usual.
   */
  readonly create?: boolean;
  /** Test seam for the migration path. */
  readonly migrations?: readonly string[];
}

/** One manifest file per (absolute folder, device, remote root). */
export function manifestFileName(key: ManifestKey): string {
  const digest = createHash('sha256')
    .update(`${key.folder}\0${key.device}\0${key.remoteRoot}`)
    .digest('hex');
  return `${digest.slice(0, 16)}.sqlite`;
}

type Row = Record<string, unknown>;

const toFile = (row: Row): FileRow => ({
  relPath: row.rel_path as string,
  size: row.size as number,
  mtimeMs: row.mtime_ms as number,
  sha256: row.sha256 as string,
  driveId: (row.drive_id as string | null) ?? undefined,
  uploadedAt: (row.uploaded_at as number | null) ?? undefined,
});

export class Manifest {
  /** The database file, or `:memory:`. */
  readonly path: string;
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync, path: string) {
    this.#db = db;
    this.path = path;
  }

  get schemaVersion(): number {
    const row = this.#db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    return Number(row?.value ?? 0);
  }

  get(relPath: string): FileRow | undefined {
    const row = this.#db.prepare('SELECT * FROM files WHERE rel_path = ?').get(relPath);
    return row ? toFile(row) : undefined;
  }

  /** Same content, new modification time: remember the time so the next run skips the hash. */
  touchMtime(relPath: string, mtimeMs: number): void {
    this.#db.prepare('UPDATE files SET mtime_ms = ? WHERE rel_path = ?').run(mtimeMs, relPath);
  }

  recordUpload(
    relPath: string,
    file: { size: number; mtimeMs: number; sha256: string; driveId: string },
    uploadedAt: number = Date.now(),
  ): void {
    this.#db
      .prepare(
        `INSERT INTO files (rel_path, size, mtime_ms, sha256, drive_id, uploaded_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(rel_path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms,
           sha256 = excluded.sha256, drive_id = excluded.drive_id, uploaded_at = excluded.uploaded_at`,
      )
      .run(relPath, file.size, file.mtimeMs, file.sha256, file.driveId, uploadedAt);
  }

  folderId(relPath: string): string | undefined {
    const row = this.#db.prepare('SELECT drive_id FROM folders WHERE rel_path = ?').get(relPath);
    return row ? (row.drive_id as string) : undefined;
  }

  setFolderId(relPath: string, driveId: string): void {
    this.#db
      .prepare(
        `INSERT INTO folders (rel_path, drive_id) VALUES (?, ?)
         ON CONFLICT(rel_path) DO UPDATE SET drive_id = excluded.drive_id`,
      )
      .run(relPath, driveId);
  }

  /** A resumable upload in progress. The URI is a secret: this file is owner-only. */
  session(relPath: string): SessionRow | undefined {
    const row = this.#db.prepare('SELECT * FROM sessions WHERE rel_path = ?').get(relPath);
    if (!row) return undefined;
    return {
      relPath: row.rel_path as string,
      sessionUri: row.session_uri as string,
      offset: row.offset as number,
      size: row.size as number,
      sha256: row.sha256 as string,
      startedAt: row.started_at as number,
    };
  }

  setSession(session: SessionRow): void {
    this.#db
      .prepare(
        `INSERT INTO sessions (rel_path, session_uri, offset, size, sha256, started_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(rel_path) DO UPDATE SET session_uri = excluded.session_uri,
           offset = excluded.offset, size = excluded.size, sha256 = excluded.sha256,
           started_at = excluded.started_at`,
      )
      .run(
        session.relPath,
        session.sessionUri,
        session.offset,
        session.size,
        session.sha256,
        session.startedAt,
      );
  }

  clearSession(relPath: string): void {
    this.#db.prepare('DELETE FROM sessions WHERE rel_path = ?').run(relPath);
  }

  close(): void {
    this.#db.close();
  }
}

function migrate(db: DatabaseSync, migrations: readonly string[]): void {
  const hasMeta = db
    .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
    .get();
  const current = hasMeta
    ? Number(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value ?? 0)
    : 0;
  for (let version = current; version < migrations.length; version += 1) {
    db.exec('BEGIN');
    try {
      db.exec(migrations[version] ?? '');
      db.prepare(
        `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(String(version + 1));
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

export function openManifest(options: OpenManifestOptions): Manifest {
  const migrations = options.migrations ?? MIGRATIONS;
  const dir = join(options.dataDir, 'manifests');
  const file = join(dir, manifestFileName(options));
  let target = file;
  let exists = true;
  try {
    closeSync(openSync(file, 'r'));
  } catch {
    exists = false;
  }
  if (exists && process.platform !== 'win32') {
    // A manifest holds resumable session URIs: tighten one that an older run or a copy left open.
    chmodSync(file, 0o600);
    chmodSync(dir, 0o700);
  } else if (!exists) {
    if (options.create === false) {
      target = ':memory:';
    } else {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      // Created with owner-only access before SQLite touches it: the file will hold resumable
      // session URIs, which act as bearer credentials.
      closeSync(openSync(file, 'wx', 0o600));
    }
  }
  const db = new DatabaseSync(target);
  try {
    // A rollback journal, not WAL: no -wal or -shm side files to protect or leave behind.
    db.exec('PRAGMA journal_mode = DELETE');
    migrate(db, migrations);
    const info = db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)');
    info.run('folder', options.folder);
    info.run('device', options.device);
    info.run('remote_root', options.remoteRoot);
  } catch (error) {
    db.close();
    throw error;
  }
  return new Manifest(db, target);
}
