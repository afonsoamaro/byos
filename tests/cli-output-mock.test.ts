import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

// PP-02: the CLI output mock is the reference the real commands follow, and docs/cli-output.md
// is generated from it. These tests keep the two in sync and pin the stream and JSON rules.
const script = fileURLToPath(new URL('../scripts/cli-output-mock.ts', import.meta.url));
const doc = fileURLToPath(new URL('../docs/cli-output.md', import.meta.url));

const SCENARIOS = [
  'auth',
  'auth-status',
  'doctor',
  'doctor-json',
  'backup-dry-run',
  'backup',
  'backup-interrupted',
  'error',
  'error-json',
  'ls-json',
  'stat-json',
  'mkdir-json',
  'rm-json',
  'put-json',
];

// The error codes fixed by FN-01 (core contract).
const FN01_CODES = [
  'NOT_FOUND',
  'CONFLICT',
  'PERMISSION_DENIED',
  'AUTH_FAILED',
  'RATE_LIMITED',
  'QUOTA_EXCEEDED',
  'PROVIDER_ERROR',
  'UPLOAD_SESSION_EXPIRED',
];

interface Result {
  stdout: string;
  stderr: string;
  status: number | null;
}

function spawnMock(args: string[], env: NodeJS.ProcessEnv = {}): Promise<Result> {
  // Piped stdio: stdout and stderr are not TTYs, as when a script calls the CLI. The test
  // runner's own FORCE_COLOR would override that, so it is dropped unless a case sets it.
  const { FORCE_COLOR: _ignored, ...inherited } = process.env;
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [script, ...args],
      { encoding: 'utf8', env: { ...inherited, ...env } },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') {
          reject(new Error(`the mock did not run: ${args.join(' ')}`, { cause: error }));
          return;
        }
        resolve({ stdout, stderr, status: error ? (error.code as number) : 0 });
      },
    );
  });
}

// Every run happens once, in parallel, before the tests: a Node start costs seconds on a loaded
// machine, and inside each test's 5 s timeout that flakes. The tests only read the results.
const RUNS = {
  ...Object.fromEntries(SCENARIOS.map((name) => [name, [name]])),
  forced: ['doctor'],
  quiet: ['error-json'],
  unknown: ['nope'],
  ascii: ['all', '--ascii'],
  markdown: ['--markdown'],
} as Record<string, string[]>;
const ENV: Record<string, NodeJS.ProcessEnv> = {
  forced: { FORCE_COLOR: '1' },
  quiet: { NO_COLOR: '1' },
};
const results = new Map<string, Result>();

beforeAll(async () => {
  const entries = await Promise.all(
    Object.entries(RUNS).map(
      async ([key, args]) => [key, await spawnMock(args, ENV[key])] as const,
    ),
  );
  for (const [key, result] of entries) results.set(key, result);
}, 120_000);

function run(key: string): Result {
  const result = results.get(key);
  if (!result) throw new Error(`no run named ${key}`);
  return result;
}

describe('cli output mock', () => {
  it.each(SCENARIOS)('%s prints no escape codes when piped', (scenario) => {
    const { stdout, stderr } = run(scenario);
    expect(stdout + stderr).not.toContain('\x1b[');
  });

  it('colors the output when FORCE_COLOR is set, so the piped check above is meaningful', () => {
    expect(run('forced').stdout).toContain('\x1b[');
  });

  it('error-json writes one { code, message } on stderr and nothing on stdout', () => {
    const { stdout, stderr, status } = run('quiet');
    expect(stdout).toBe('');
    const parsed = JSON.parse(stderr) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['code', 'message']);
    expect(parsed.code).toBe('NOT_FOUND');
    expect(typeof parsed.message).toBe('string');
    expect(status).toBe(3);
  });

  it('put-json writes the FN-11 shape on stdout', () => {
    const { stdout, stderr, status } = run('put-json');
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['id', 'name', 'path', 'sha256', 'size']);
    expect(stderr).toBe('');
    expect(status).toBe(0);
  });

  it('ls-json writes a JSON array on stdout', () => {
    expect(Array.isArray(JSON.parse(run('ls-json').stdout))).toBe(true);
  });

  it('backup stops on a full Drive with exit 6 and the code on stderr', () => {
    const { stderr, status } = run('backup');
    expect(stderr).toContain('QUOTA_EXCEEDED');
    expect(status).toBe(6);
  });

  it('backup-interrupted exits 130 and says the next run resumes', () => {
    const { stderr, status } = run('backup-interrupted');
    expect(stderr).toContain('resume');
    expect(status).toBe(130);
  });

  it('an unknown scenario is a usage error', () => {
    expect(run('unknown').status).toBe(2);
  });

  it('--ascii uses only the legacy-console symbols', () => {
    const { stdout, stderr } = run('ascii');
    // --json documents are UTF-8 for machines and keep their text as is (a fix can hold `›`).
    const human = (stdout + stderr).split('\n').filter((line) => !/^[{[]/.test(line));
    expect(human.join('\n')).not.toMatch(/[✓✗›…]/);
    expect(stdout).toContain('√');
  });

  it('docs/cli-output.md matches a fresh --markdown run', () => {
    expect(readFileSync(doc, 'utf8')).toBe(run('markdown').stdout);
  });

  it('touches no network and no file system: only node:util and node:process', () => {
    const source = readFileSync(script, 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    expect(imports.sort()).toEqual(['node:process', 'node:util']);
    expect(source).not.toMatch(/\bfetch\s*\(|\bimport\s*\(|\brequire\s*\(/);
  });

  it('uses only the FN-01 error codes', () => {
    const output = run('markdown').stdout;
    const used = [
      ...output.matchAll(/"code":"([A-Z_]+)"/g),
      ...output.matchAll(/✗ (?:[^\s:]+: )?([A-Z][A-Z_]+[A-Z])\b/g),
      ...output.matchAll(/\b([A-Z]+(?:_[A-Z]+)+) on /g),
    ].map((match) => match[1]);
    expect(used.length).toBeGreaterThan(3);
    for (const code of used) expect(FN01_CODES).toContain(code);
  });
});
