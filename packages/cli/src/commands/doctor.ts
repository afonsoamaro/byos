import type { Command } from 'commander';

import { openContext, type GlobalFlags } from '../context.js';
import { exitCodeForChecks, runChecks } from '../doctor/checks.js';
import type { CliIO } from '../io.js';
import type { RunState } from '../program.js';

interface DoctorFlags extends GlobalFlags {
  readonly client?: string;
}

/** `byos doctor`: the setup steps it can observe, each failure with the step that fixes it. */
export async function runDoctor(io: CliIO, state: RunState, flags: DoctorFlags): Promise<void> {
  const ctx = openContext(io, flags);
  const { out } = ctx;
  const results = await runChecks(ctx, flags.client === undefined ? {} : { client: flags.client });
  for (const check of results) {
    out.check(check.status, check.message, check.fix?.replaceAll('›', out.sym.step));
  }
  const failed = results.filter((r) => r.status === 'fail').length;
  const warnings = results.filter((r) => r.status === 'warn').length;
  out.line();
  out.line(`${String(failed)} failed, ${String(warnings)} warning${warnings === 1 ? '' : 's'}`);
  out.data({ ok: failed === 0, checks: results });
  state.exitCode = exitCodeForChecks(results);
}

export function registerDoctor(program: Command, io: CliIO, state: RunState): void {
  program
    .command('doctor')
    .description('Check your Google Cloud setup and say how to fix what is wrong')
    .option(
      '--client <file>',
      'the Desktop app OAuth client JSON (default: the one byos auth saved)',
    )
    .action(async (_options: unknown, command: Command) => {
      await runDoctor(io, state, command.optsWithGlobals<DoctorFlags>());
    });
}
