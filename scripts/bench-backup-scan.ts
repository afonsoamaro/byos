// Measures the no-change re-run of the backup scan over generated files (FN-12). Outside the
// check gate on purpose: it takes a while and the number depends on the machine.
//
//   pnpm build && node scripts/bench-backup-scan.ts [files]   (default 20000)
//
// It runs against the built CLI (`packages/cli/dist`), since Node's type stripping can't resolve
// the `.js` import specifiers of the TypeScript sources.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { openManifest } from '../packages/cli/dist/backup/manifest.js';
import { planBackup } from '../packages/cli/dist/backup/plan.js';
import { createReport, scan } from '../packages/cli/dist/backup/scan.js';
import { sha256File } from '../packages/cli/dist/local.js';

const total = Number(process.argv[2] ?? 20_000);
const root = await mkdtemp(join(tmpdir(), 'byos-bench-'));
const folder = join(root, 'photos');
const data = join(root, 'data');

try {
  const folders = 200;
  for (let d = 0; d < folders; d += 1)
    await mkdir(join(folder, `dir${String(d)}`), { recursive: true });
  for (let i = 0; i < total; i += 1) {
    await writeFile(
      join(folder, `dir${String(i % folders)}`, `IMG_${String(i)}.jpg`),
      `photo ${String(i)}`,
    );
  }

  const manifest = openManifest({
    dataDir: data,
    folder,
    device: 'bench',
    remoteRoot: 'BYOS Backup',
  });
  let hashCalls = 0;
  const hash = (path: string) => {
    hashCalls += 1;
    return sha256File(path);
  };
  const run = () => {
    const report = createReport();
    return planBackup({ entries: scan(folder, {}, report), report, manifest, hash, dryRun: true });
  };

  let started = performance.now();
  const first = await run();
  const firstSeconds = (performance.now() - started) / 1000;
  const firstHashes = hashCalls;

  first.toUpload.forEach((item, i) => {
    manifest.recordUpload(item.relPath, { ...item, driveId: `id-${String(i)}` });
  });

  hashCalls = 0;
  started = performance.now();
  const second = await run();
  const secondSeconds = (performance.now() - started) / 1000;

  console.log(
    `${String(total)} files, first plan ${firstSeconds.toFixed(2)} s (${String(firstHashes)} hashes, ` +
      `${String(first.toUpload.length)} to upload), no-change re-run ${secondSeconds.toFixed(2)} s ` +
      `(${String(hashCalls)} hash calls, ${String(second.toUpload.length)} to upload)`,
  );
  manifest.close();
} finally {
  await rm(root, { recursive: true, force: true });
}
