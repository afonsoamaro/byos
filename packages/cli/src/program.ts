import { readFileSync } from 'node:fs';

import { Command } from 'commander';

// One level up from both `src/` and `dist/`, so the same path works in tests and in the build.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export function createProgram(): Command {
  return new Command()
    .name('byos')
    .description('Bring Your Own Storage: keep files in your own cloud drive.')
    .version(pkg.version);
}
