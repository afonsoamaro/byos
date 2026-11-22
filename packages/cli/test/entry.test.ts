import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import pkg from '../package.json' with { type: 'json' };

// The real entry point, spawned: the in-process tests call main(), and this proves bin.ts wires
// it up (shebang, exit code). Run once, so a loaded machine isn't asked for a Node start per case.
const bin = fileURLToPath(new URL('../dist/bin.js', import.meta.url));

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

const run = (args: string[]) =>
  new Promise<Run>((resolve) => {
    execFile(process.execPath, [bin, ...args], { encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
    });
  });

const results: Record<string, Run> = {};

beforeAll(async () => {
  if (!existsSync(bin)) throw new Error('packages/cli/dist is missing: run pnpm build first');
  results.version = await run(['--version']);
  results.unknown = await run(['no-such-command']);
  results.json = await run(['--json', 'no-such-command']);
}, 60_000);

describe('the byos binary', () => {
  it('prints its version and exits 0', () => {
    expect(results.version).toMatchObject({ code: 0, stdout: `${pkg.version}\n` });
  });

  it('exits 2 on an unknown command, with a USAGE error on stderr', () => {
    expect(results.unknown?.code).toBe(2);
    expect(results.unknown?.stderr).toContain('USAGE');
  });

  it('keeps --json errors to one JSON line on stderr', () => {
    expect(results.json?.code).toBe(2);
    expect(results.json?.stdout).toBe('');
    expect(JSON.parse(results.json?.stderr ?? '')).toMatchObject({ code: 'USAGE' });
  });
});
