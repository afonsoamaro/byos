import { hostname } from 'node:os';
import { stat } from 'node:fs/promises';

import type { Command } from 'commander';

import { AuthError } from '@byos/core';

import { deviceName } from '../backup/device.js';
import { openManifest, type Manifest } from '../backup/manifest.js';
import { planBackup, type Plan } from '../backup/plan.js';
import { Progress } from '../backup/progress.js';
import { createReport, scan } from '../backup/scan.js';
import { runBackup, type BackupProvider, type Failure, type RunResult } from '../backup/upload.js';
import { openContext, openStorage, type Context, type GlobalFlags } from '../context.js';
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
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 16;

interface BackupFlags extends GlobalFlags {
  readonly device?: string;
  readonly remoteRoot?: string;
  readonly exclude?: readonly string[];
  readonly dryRun?: boolean;
  readonly concurrency?: string;
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

function concurrencyOf(raw: string | undefined): number {
  const n = Number(raw ?? DEFAULT_CONCURRENCY);
  if (!Number.isInteger(n) || n < 1) {
    throw new CliError('--concurrency needs a whole number of 1 or more', 2, 'USAGE');
  }
  return Math.min(n, MAX_CONCURRENCY);
}

const plural = (n: number, noun: string): string =>
  `${count.format(n)} ${noun}${n === 1 ? '' : 's'}`;

const STOP_CODE = {
  quota: 'QUOTA_EXCEEDED',
  auth: 'AUTH_FAILED',
  interrupt: 'INTERRUPTED',
} as const;
const STOP_EXIT = { quota: 6, auth: 5, interrupt: 130 } as const;

/** The closing message for a run that stopped early, in the PP-02 words. */
function stopMessage(plan: Plan, result: RunResult): { message: string; hint: string } {
  const recorded = `${count.format(result.uploaded)} of ${count.format(plan.toUpload.length)} files were uploaded and recorded.`;
  switch (result.stoppedBy) {
    case 'quota':
      return {
        message: `your Google Drive is full. ${recorded}`,
        hint: 'Free up space or upgrade storage, then run the same command: it resumes where it stopped.',
      };
    case 'auth':
      return {
        message: `${result.stopError?.message ?? 'Google refused the sign-in'}. ${recorded}`,
        hint: 'Run byos auth, then the same command: it resumes where it stopped.',
      };
    default:
      return {
        message: `${plural(result.uploaded, 'file')} ${result.uploaded === 1 ? 'was' : 'were'} uploaded and recorded; ${plural(result.partial, 'partial upload')} ${result.partial === 1 ? 'was' : 'were'} saved.`,
        hint: 'Run the same command to resume.',
      };
  }
}

async function runUpload(
  ctx: Context,
  plan: Plan,
  manifest: Manifest,
  provider: BackupProvider,
  base: readonly string[],
  concurrency: number,
  progress: Progress,
  signal: AbortSignal,
  state: RunState,
): Promise<void> {
  const { out, io } = ctx;
  const failures: Failure[] = plan.errors.map((e) => ({
    relPath: e.relPath,
    code: e.code,
    message: e.message,
  }));
  const result = await runBackup({
    items: plan.toUpload,
    manifest,
    provider,
    base,
    concurrency,
    signal,
    now: io.now,
    observer: {
      started: (relPath) => {
        progress.started(relPath);
      },
      finished: (relPath, size) => {
        progress.finished(relPath, size);
      },
      failed: (failure) => {
        failures.push(failure);
        progress.failed(failure.relPath);
        progress.interject(() => {
          out.fail(
            printable(
              `${failure.relPath}: ${failure.code}: ${failure.message} (file skipped, run continues)`,
            ),
          );
        });
      },
    },
  });
  progress.end();

  const stopped = result.stoppedBy;
  if (stopped !== undefined) {
    const { message, hint } = stopMessage(plan, result);
    const reason = result.stopError instanceof AuthError ? result.stopError.reason : undefined;
    out.jsonError({
      code: STOP_CODE[stopped],
      message,
      ...(reason === undefined ? {} : { reason }),
    });
    out.errLine();
    if (stopped === 'interrupt') out.warn(`Interrupted. ${message}`, hint);
    else out.fail(`${STOP_CODE[stopped]}: ${printable(message)}`, hint);
  }
  const failed = failures.length;
  const remaining = result.remaining;
  if (stopped !== 'interrupt') {
    out.line();
    out.line(
      `uploaded ${count.format(result.uploaded)}, skipped ${count.format(plan.unchanged)}, failed ${count.format(failed)}, remaining ${count.format(remaining)}`,
    );
  }
  out.data({
    uploaded: result.uploaded,
    skipped: plan.unchanged,
    failed,
    remaining,
    ...(stopped === undefined ? {} : { stoppedBy: stopped }),
    failures,
  });
  state.exitCode = stopped === undefined ? (failed > 0 ? 1 : 0) : STOP_EXIT[stopped];
}

async function backupCommand(io: CliIO, flags: BackupFlags, folderArg: string, state: RunState) {
  const ctx = openContext(io, flags);
  const api = pathApi(io.platform);
  const concurrency = concurrencyOf(flags.concurrency);
  const folder = api.resolve(folderArg);
  const info = await stat(folder).catch(() => undefined);
  if (!info?.isDirectory()) throw new CliError(`${folderArg} is not a folder`, 2, 'USAGE');

  const dryRun = flags.dryRun === true;
  const device = deviceName(flags.device ?? hostname());
  const remoteRoot = flags.remoteRoot ?? DEFAULT_REMOTE_ROOT;
  assertRemotePath(remoteRoot);
  const base = [...remoteRoot.split('/').filter(Boolean), device, api.basename(folder) || 'root'];
  const remote = base.join('/');

  // Signing in comes first: a missing client file should not cost a long scan.
  let progress: Progress | undefined;
  const provider = dryRun
    ? undefined
    : ((await openStorage(ctx, {
        onUploadProgress: (event) => progress?.bytes(event.name, event.bytesConfirmed),
      })) as BackupProvider);

  const manifest = openManifest({
    dataDir: dataDir({ platform: io.platform, env: io.env, homedir: io.homedir }),
    folder,
    device,
    remoteRoot,
    create: !dryRun,
  });
  const controller = new AbortController();
  const stopListening = dryRun
    ? undefined
    : io.onInterrupt?.(() => {
        controller.abort();
      });
  try {
    const report = createReport();
    const plan = await planBackup({
      entries: scan(folder, { exclude: flags.exclude ?? [] }, report),
      report,
      manifest,
      dryRun,
    });
    summarize(ctx.out, folder, remote, plan);
    for (const warning of plan.warnings) ctx.out.warn(printable(warning));
    for (const error of plan.errors) ctx.out.fail(printable(error.message));

    if (dryRun || provider === undefined) {
      listPlan(ctx.out, plan);
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
      return;
    }
    if (plan.toUpload.length === 0) ctx.out.line('Nothing to upload.');
    progress = new Progress({
      sink: io.out,
      enabled: !ctx.out.json && plan.toUpload.length > 0,
      total: plan.toUpload.length,
      totalBytes: plan.bytes,
      now: io.now,
    });
    await runUpload(
      ctx,
      plan,
      manifest,
      provider,
      base,
      concurrency,
      progress,
      controller.signal,
      state,
    );
  } finally {
    stopListening?.();
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
    .option(
      '--concurrency <n>',
      `files to upload at once (1 to ${String(MAX_CONCURRENCY)})`,
      String(DEFAULT_CONCURRENCY),
    )
    .option('--dry-run', 'scan and show what would upload, change nothing')
    .description('Back a folder up to Drive, keeping every file (nothing is ever deleted)')
    .action(async (folder: string, _options: unknown, command: Command) => {
      await backupCommand(io, command.optsWithGlobals<BackupFlags>(), folder, state);
    });
}
