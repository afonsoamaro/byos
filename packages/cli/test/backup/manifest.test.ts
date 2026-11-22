import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { MIGRATIONS, manifestFileName, openManifest } from '../../src/backup/manifest.js';
import { cleanupBackup, manifestFor, tmp } from './fixtures.js';

afterEach(cleanupBackup);

const key = { folder: '/photos', device: 'laptop', remoteRoot: 'BYOS Backup' };

describe('manifest', () => {
  it('a fresh database has schema version 1, the four tables and the key in meta', async () => {
    const data = await tmp();
    const manifest = manifestFor(data, key.folder, key);
    expect(manifest.schemaVersion).toBe(1);
    manifest.close();
    const db = new DatabaseSync(manifest.path, { readOnly: true });
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name);
    expect(tables).toEqual(['files', 'folders', 'meta', 'sessions']);
    const meta: Record<string, unknown> = {};
    for (const row of db.prepare('SELECT key, value FROM meta').all()) {
      meta[row.key as string] = row.value;
    }
    expect(meta).toEqual({
      schema_version: '1',
      folder: key.folder,
      device: key.device,
      remote_root: key.remoteRoot,
    });
    db.close();
  });

  it('keeps its data when it is opened again', async () => {
    const data = await tmp();
    const first = manifestFor(data, key.folder, key);
    first.recordUpload(
      'a/b.jpg',
      { size: 3, mtimeMs: 1700000000000.5, sha256: 'ab', driveId: 'd1' },
      99,
    );
    first.setFolderId('a', 'folder-1');
    first.setSession({
      relPath: 'c.mov',
      sessionUri: 'https://upload.example/session-secret',
      offset: 8,
      size: 16,
      sha256: 'cd',
      startedAt: 5,
    });
    first.close();
    const second = manifestFor(data, key.folder, key);
    expect(second.get('a/b.jpg')).toEqual({
      relPath: 'a/b.jpg',
      size: 3,
      mtimeMs: 1700000000000.5,
      sha256: 'ab',
      driveId: 'd1',
      uploadedAt: 99,
    });
    expect(second.folderId('a')).toBe('folder-1');
    expect(second.session('c.mov')?.sessionUri).toBe('https://upload.example/session-secret');
    second.clearSession('c.mov');
    expect(second.session('c.mov')).toBeUndefined();
    expect(second.get('missing')).toBeUndefined();
  });

  it('applies a later migration once, to a database made by an earlier version', async () => {
    const data = await tmp();
    const v2 = [...MIGRATIONS, 'ALTER TABLE files ADD COLUMN note TEXT;'];
    manifestFor(data, key.folder, key).close();
    const upgraded = openManifest({ dataDir: data, ...key, migrations: v2 });
    expect(upgraded.schemaVersion).toBe(2);
    upgraded.close();
    // Opening again must not try to add the column a second time.
    const again = openManifest({ dataDir: data, ...key, migrations: v2 });
    expect(again.schemaVersion).toBe(2);
    again.close();
  });

  it('a migration that fails leaves the previous version in place', async () => {
    const data = await tmp();
    manifestFor(data, key.folder, key).close();
    const broken = [...MIGRATIONS, 'ALTER TABLE files ADD COLUMN a TEXT; THIS IS NOT SQL;'];
    expect(() => openManifest({ dataDir: data, ...key, migrations: broken })).toThrow();
    const ok = openManifest({ dataDir: data, ...key });
    expect(ok.schemaVersion).toBe(1);
    ok.close();
  });

  it.skipIf(process.platform === 'win32')(
    'is owner-only: file 0600, folder 0700, no side files',
    async () => {
      const data = await tmp();
      const manifest = manifestFor(data, key.folder, key);
      manifest.recordUpload('a', { size: 1, mtimeMs: 1, sha256: 'x', driveId: 'y' });
      expect((await stat(manifest.path)).mode & 0o777).toBe(0o600);
      expect((await stat(join(data, 'manifests'))).mode & 0o777).toBe(0o700);
      expect(await readdir(join(data, 'manifests'))).toEqual([manifestFileName(key)]);
    },
  );

  it('keeps one file per folder, device and remote root', () => {
    const names = new Set([
      manifestFileName(key),
      manifestFileName({ ...key, folder: '/other' }),
      manifestFileName({ ...key, device: 'desktop' }),
      manifestFileName({ ...key, remoteRoot: 'Elsewhere' }),
    ]);
    expect(names.size).toBe(4);
    expect(manifestFileName(key)).toBe(manifestFileName({ ...key }));
  });

  it('a dry-run manifest creates no file when there is none', async () => {
    const data = await tmp();
    const manifest = openManifest({ dataDir: data, ...key, create: false });
    expect(manifest.path).toBe(':memory:');
    expect(manifest.schemaVersion).toBe(1);
    manifest.close();
    expect(await readdir(data)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'tightens a manifest that was left open to others',
    async () => {
      const { chmod } = await import('node:fs/promises');
      const data = await tmp();
      const first = manifestFor(data, key.folder, key);
      first.close();
      await chmod(first.path, 0o644);
      await chmod(join(data, 'manifests'), 0o755);
      manifestFor(data, key.folder, key);
      expect((await stat(first.path)).mode & 0o777).toBe(0o600);
      expect((await stat(join(data, 'manifests'))).mode & 0o777).toBe(0o700);
    },
  );
});
