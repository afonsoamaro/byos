import { hostname } from 'node:os';
import { stat } from 'node:fs/promises';

import type { Command } from 'commander';

import { deviceName } from '../backup/device.js';
import { openManifest } from '../backup/manifest.js';
import { planBackup, type Plan } from '../backup/plan.js';
import { createReport, scan } from '../backup/scan.js';
import { openContext, type GlobalFlags } from '../context.js';
import { CliError } from '../errors.js';
import { formatBytes, printable } from '../format.js';
import type { CliIO } from '../io.js';
import { pathApi } from '../local.js';
import type { Output } from '../output.js';
import { assertRemotePath } from '../remote.js';
import { dataDir } from '../store/paths.js';
import type { RunState } from '../program.js';

const DEFAULT_REMOTE_ROOT = 'BYOS Backup';
const SAMPLE = 6;

interface BackupFlags extends GlobalFlags {
  readonly device?: string;
  readonly remoteRoot?: string;
  readonly exclude?: readonly string[];
  readonly dryRun?: boolean;
}

const count = new Intl.NumberFormat('en-US');

function summarize(out: Output, folder: string, remote: string, plan: Plan): void {
  const width = count.format(plan.found).length;
  const num = (n: number) => count.format(n).padStart(width);
  out.line(`Scanning ${out.link(printable(folder))}`);
  out.line(`  ${num(plan.found)} files found`);
  out.line(`  ${num(plan.unchanged)} unchanged`);
  out.line(`  ${num(plan.toUpload.length)} to upload (${formatBytes(plan.bytes)})`);
  if (plan.skipped.length > 0) {
    const reasons = new Map<string, number>();
    for (const item of plan.skipped) reasons.set(item.reason, (reasons.get(item.reason) ?? 0) + 1);
    const detail = [...reasons].map(([reason, n]) => `${reason} ${String(n)}`).join(', ');
    out.line(`  ${num(plan.skipped.length)} skipped (${detail})`);
  }
  out.line(`  remote ${out.link(printable(remote))}`);
  out.line();
}

function listPlan(out: Output, plan: Plan): void {
  if (plan.toUpload.length === 0) {
    out.line('Nothing to upload.');
    return;
  }
  out.line(
    `Would upload ${count.format(plan.toUpload.length)} files (${formatBytes(plan.bytes)}):`,
  );
  const sample = plan.toUpload.slice(0, SAMPLE);
  const width = Math.max(...sample.map((item) => printable(item.relPath).length));
  for (const item of sample) {
    out.line(`  ${printable(item.relPath).padEnd(width)}  ${formatBytes(item.size).padStart(8)}`);
  }
  const more = plan.toUpload.length - sample.length;
  if (more > 0) out.line(`  ${out.sym.wait} and ${count.format(more)} more`);
}

async function runBackup(io: CliIO, flags: BackupFlags, folderArg: string, state: RunState) {
  if (flags.dryRun !== true) {
    throw new CliError('uploading arrives with the next release; use --dry-run', 2, 'USAGE');
  }
  const ctx = openContext(io, flags);
  const api = pathApi(io.platform);
  const folder = api.resolve(folderArg);
  const info = await stat(folder).catch(() => undefined);
  if (!info?.isDirectory()) throw new CliError(`${folderArg} is not a folder`, 2, 'USAGE');

  const device = deviceName(flags.device ?? hostname());
  const remoteRoot = flags.remoteRoot ?? DEFAULT_REMOTE_ROOT;
  assertRemotePath(remoteRoot);
  const remote = [
    ...remoteRoot.split('/').filter(Boolean),
    device,
    api.basename(folder) || 'root',
  ].join('/');

  const manifest = openManifest({
    dataDir: dataDir({ platform: io.platform, env: io.env, homedir: io.homedir }),
    folder,
    device,
    remoteRoot,
    create: false,
  });
  try {
    const report = createReport();
    const plan = await planBackup({
      entries: scan(folder, { exclude: flags.exclude ?? [] }, report),
      report,
      manifest,
      dryRun: true,
    });
    summarize(ctx.out, folder, remote, plan);
    listPlan(ctx.out, plan);
    for (const warning of plan.warnings) ctx.out.warn(printable(warning));
    for (const error of plan.errors) ctx.out.fail(printable(error.message));
    ctx.out.data({
      found: plan.found,
      unchanged: plan.unchanged,
      toUpload: plan.toUpload.map((item) => item.relPath),
      bytes: plan.bytes,
      skipped: plan.skipped,
      warnings: plan.warnings,
      errors: plan.errors,
    });
    state.exitCode = plan.errors.length > 0 ? 1 : 0;
  } finally {
    manifest.close();
  }
}

const collect = (value: string, previous: readonly string[]): string[] => [...previous, value];

export function registerBackup(program: Command, io: CliIO, state: RunState): void {
  program
    .command('backup')
    .argument('<folder>', 'the local folder to back up')
    .option('--device <name>', 'the device folder name in Drive (default: this computer)')
    .option('--remote-root <name>', 'the top folder in Drive', DEFAULT_REMOTE_ROOT)
    .option(
      '--exclude <glob>',
      "skip paths matching a glob, e.g. '**/*.tmp' (repeatable)",
      collect,
      [],
    )
    .option('--dry-run', 'scan and show what would upload, change nothing')
    .description('Back a folder up to Drive, keeping every file (nothing is ever deleted)')
    .action(async (folder: string, _options: unknown, command: Command) => {
      await runBackup(io, command.optsWithGlobals<BackupFlags>(), folder, state);
    });
}
