import { readFileSync } from 'node:fs';

import { Command } from 'commander';

import { registerAuth } from './commands/auth.js';
import { registerDoctor } from './commands/doctor.js';
import { registerFiles } from './commands/files.js';
import type { CliIO } from './io.js';

// One level up from both `src/` and `dist/`, so the same path works in tests and in the build.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

/** Commands can set the exit code they want (a failed check, say) without throwing. */
export interface RunState {
  exitCode: number;
}

export function createProgram(io: CliIO, state: RunState = { exitCode: 0 }): Command {
  const program = new Command()
    .name('byos')
    .description('Bring Your Own Storage: keep files in your own cloud drive.')
    .version(pkg.version)
    .option('--config-dir <dir>', 'config folder (default per platform, or BYOS_CONFIG_DIR)')
    .option('--json', 'machine-readable output: one JSON document, nothing else')
    // Errors surface through main(), which prints them the PP-02 way and picks the exit code.
    .exitOverride()
    .configureOutput({
      writeOut: (text) => {
        io.out.write(text);
      },
      writeErr: (text) => {
        io.err.write(text);
      },
      outputError: () => undefined,
    });
  registerAuth(program, io);
  registerDoctor(program, io, state);
  registerFiles(program, io);
  return program;
}
