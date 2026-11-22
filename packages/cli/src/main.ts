import { CommanderError } from 'commander';

import { CliError, report } from './errors.js';
import type { CliIO } from './io.js';
import { createOutput } from './output.js';
import { createProgram, type RunState } from './program.js';

/** Runs the CLI with `argv` (without `node` and the script) and returns its exit code. */
export async function main(argv: string[], io: CliIO): Promise<number> {
  const state: RunState = { exitCode: 0 };
  const out = createOutput(io, { json: argv.includes('--json') });
  try {
    await createProgram(io, state).parseAsync(argv, { from: 'user' });
    return state.exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      // --help and --version are not failures; anything else is a usage mistake.
      if (error.exitCode === 0) return 0;
      return report(out, new CliError(error.message.replace(/^error: /, ''), 2, 'USAGE'));
    }
    return report(out, error);
  }
}
