// Prototype for PP-02: prints what the `byos` CLI will show, with mock data only.
// Nothing imports this file. The real CLI follows docs/cli-output.md, which this script
// generates with `--markdown`. No network and no file system: it only writes to stdout/stderr.
//
// Usage: node scripts/cli-output-mock.ts <scenario|all> [--ascii]
//        node scripts/cli-output-mock.ts --markdown > docs/cli-output.md
import process from 'node:process';
import { styleText } from 'node:util';

type Format = Parameters<typeof styleText>[0];

interface Sink {
  readonly tty: boolean;
  // Present for a real stream: styleText then decides about color (TTY, NO_COLOR, FORCE_COLOR).
  readonly stream?: NodeJS.WriteStream;
  write(text: string): void;
}

interface Symbols {
  ok: string;
  warn: string;
  fail: string;
  step: string;
  wait: string;
  rule: string;
}

interface Ctx {
  out: Sink;
  err: Sink;
  sym: Symbols;
  animate: boolean;
}

const UNICODE: Symbols = { ok: '✓', warn: '!', fail: '✗', step: '›', wait: '…', rule: '──' };
// Characters from code page 437, which the legacy Windows console renders with its default font.
const ASCII: Symbols = { ok: '√', warn: '!', fail: '×', step: '>', wait: '...', rule: '--' };

// The rule the real CLI uses: Unicode unless this is the legacy Windows console.
function supportsUnicode(): boolean {
  if (process.platform !== 'win32') return true;
  return Boolean(process.env.WT_SESSION) || process.env.TERM_PROGRAM === 'vscode';
}

function paint(format: Format, text: string, sink: Sink): string {
  return sink.stream ? styleText(format, text, { stream: sink.stream }) : text;
}

const count = new Intl.NumberFormat('en-US');
const fmtCount = (n: number): string => count.format(n);

// Binary units labeled like Windows Explorer does (GiB shown as GB).
// Copy of formatBytes in packages/cli/src/format.ts: this script runs under plain Node and does not load the TS package.
function fmtBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${String(n)} B` : `${value.toFixed(1)} ${units[unit] ?? 'B'}`;
}

const GB = 1024 ** 3;
const MOCK = {
  account: 'owner@example.com',
  folder: 'C:\\Users\\me\\Pictures',
  remote: 'BYOS Backup/DESKTOP-01/Pictures',
  found: 12431,
  unchanged: 11980,
  toUpload: 451,
  skipped: 38,
  totalBytes: Math.round(38.2 * GB),
  uploadedBeforeQuota: 214,
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

function line(sink: Sink, text = ''): void {
  sink.write(`${text}\n`);
}

function rows(sink: Sink, pairs: [string, string][], indent = '  '): void {
  const width = Math.max(...pairs.map(([key]) => key.length));
  for (const [key, value] of pairs) {
    line(sink, `${indent}${paint('dim', key.padEnd(width), sink)}  ${value}`);
  }
}

// ── scenarios ──────────────────────────────────────────────────────────────

function auth({ out, sym }: Ctx): number {
  line(out, `${sym.step} Opening your browser to sign in to Google${sym.wait}`);
  line(out, '  If no browser opened, visit:');
  const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${sym.wait}&scope=drive.file&code_challenge=${sym.wait}`;
  line(out, `  ${paint('cyan', url, out)}`);
  line(out, `${sym.wait} Waiting for Google (times out in 5 minutes)`);
  line(out, `${paint('green', sym.ok, out)} Connected as ${MOCK.account}`);
  rows(out, [['scopes', 'drive.file']]);
  return 0;
}

function authStatus({ out, err, sym }: Ctx): number {
  rows(
    out,
    [
      ['account', MOCK.account],
      ['scopes', 'drive.file'],
      ['consented', '2026-11-12 (7 days ago)'],
      ['token', 'refreshed 2 hours ago'],
    ],
    '',
  );
  line(err, '');
  line(
    err,
    `${paint('yellow', sym.warn, err)} Consent is 7 days old. If your Google Cloud consent screen is in Testing, Google expires the refresh token after 7 days.`,
  );
  line(
    err,
    `  Publish the app (OAuth consent screen ${sym.step} Publish app) or run byos auth again.`,
  );
  return 0;
}

function doctor({ out, sym }: Ctx): number {
  const pass = (label: string, detail?: string) => {
    line(out, `${paint('green', sym.ok, out)} ${label}`);
    if (detail) line(out, `  ${paint('dim', detail, out)}`);
  };
  const problem = (kind: 'warn' | 'fail', label: string, fix: string) => {
    const mark = kind === 'fail' ? paint('red', sym.fail, out) : paint('yellow', sym.warn, out);
    line(out, `${mark} ${label}`);
    line(out, `  fix: ${fix}`);
  };
  pass('Client file found', 'C:\\Users\\me\\byos\\client_secret.json');
  pass('Client type is Desktop');
  pass('Drive API reachable');
  pass('Scopes: drive.file');
  problem('fail', 'Token valid', 'run byos auth');
  problem(
    'warn',
    'Consent screen may be in Testing',
    `Google Cloud console ${sym.step} APIs & Services ${sym.step} OAuth consent screen ${sym.step} Publish app`,
  );
  line(out);
  line(out, '1 failed, 1 warning');
  return 5;
}

function doctorJson({ out }: Ctx): number {
  const checks = [
    { id: 'client-file', status: 'pass', message: 'Client file found, and it is a Desktop app' },
    {
      id: 'token',
      status: 'fail',
      message: 'The sign-in is no longer valid',
      fix: 'run byos auth',
    },
    { id: 'drive-api', status: 'skip', message: 'Needs a valid sign-in first' },
    { id: 'scopes', status: 'pass', message: 'Scopes: drive.file' },
    {
      id: 'testing-mode',
      status: 'warn',
      message:
        "If your OAuth consent screen is in Testing, Google expires refresh tokens 7 days after consent and limits the app to 100 test users. BYOS can't read the publishing status through the API, so this is a reminder, not a check.",
      fix: 'Google Cloud console › APIs & Services › OAuth consent screen › Publish app',
    },
  ];
  line(out, JSON.stringify({ ok: false, checks }));
  return 5;
}

function scanSummary({ out }: Ctx): void {
  line(out, `Scanning ${paint('cyan', MOCK.folder, out)}`);
  const width = fmtCount(MOCK.found).length;
  const num = (n: number) => fmtCount(n).padStart(width);
  line(out, `  ${num(MOCK.found)} files found`);
  line(out, `  ${num(MOCK.unchanged)} unchanged`);
  line(out, `  ${num(MOCK.toUpload)} to upload (${fmtBytes(MOCK.totalBytes)})`);
  line(out, `  ${num(MOCK.skipped)} skipped (hidden 31, system 5, symlink 2)`);
  line(out, `  remote ${paint('cyan', MOCK.remote, out)}`);
  line(out);
}

const SAMPLE_FILES: [string, number][] = [
  ['2026/10/IMG_2988.HEIC', 2.4 * 1024 ** 2],
  ['2026/10/IMG_2989.HEIC', 2.1 * 1024 ** 2],
  ['2026/11/IMG_3001.HEIC', 3.3 * 1024 ** 2],
  ['2026/11/VID_0412.mp4', 3.1 * GB],
  ['2026/11/IMG_3002.HEIC', 2.7 * 1024 ** 2],
  ['2026/11/Screenshot 2026-11-14.png', 812 * 1024],
];

function backupDryRun(ctx: Ctx): number {
  const { out, sym } = ctx;
  scanSummary(ctx);
  line(out, `Would upload ${fmtCount(MOCK.toUpload)} files (${fmtBytes(MOCK.totalBytes)}):`);
  const width = Math.max(...SAMPLE_FILES.map(([name]) => name.length));
  for (const [name, size] of SAMPLE_FILES) {
    line(out, `  ${name.padEnd(width)}  ${fmtBytes(size).padStart(8)}`);
  }
  line(out, `  ${sym.wait} and ${fmtCount(MOCK.toUpload - SAMPLE_FILES.length)} more`);
  return 0;
}

interface Frame {
  done: number;
  current: string;
  // A line printed after this frame (retry notice, per-file failure).
  note?: { sink: 'out' | 'err'; text: (ctx: Ctx) => string };
}

const FRAMES: Frame[] = [
  { done: 20, current: '2026/01/IMG_0102.HEIC' },
  { done: 45, current: '2026/02/IMG_0450.HEIC' },
  { done: 70, current: '2026/04/IMG_1180.HEIC' },
  {
    done: 90,
    current: '2026/11/IMG_3001.HEIC',
    note: {
      sink: 'out',
      text: ({ out, sym }) =>
        paint('dim', `${sym.step} RATE_LIMITED on IMG_3001.HEIC, retrying in 4 s`, out),
    },
  },
  { done: 115, current: '2026/06/IMG_1730.HEIC' },
  {
    done: 135,
    current: '2026/10/IMG_2990.HEIC',
    note: {
      sink: 'err',
      text: ({ err, sym }) =>
        `${paint('red', sym.fail, err)} 2026/10/IMG_2990.HEIC: PERMISSION_DENIED (file skipped, run continues)`,
    },
  },
  { done: 160, current: '2026/11/VID_0412.mp4' },
  { done: 180, current: '2026/11/VID_0412.mp4' },
  { done: 200, current: '2026/11/IMG_3150.HEIC' },
  { done: 214, current: '2026/11/IMG_3163.HEIC' },
];

function progressText(done: number, current: string, total: number): string {
  const bytes = (done / MOCK.toUpload) * MOCK.totalBytes;
  const files = `${String(done).padStart(String(total).length)}/${String(total)}`;
  return `[ ${files} ]  ${fmtBytes(bytes)} / ${fmtBytes(MOCK.totalBytes)}  12.4 MB/s  ${current}`;
}

// TTY: one line redrawn in place. Not a TTY: a plain line at every 10% step and at the end.
async function runProgress(ctx: Ctx, frames: Frame[]): Promise<void> {
  const { out } = ctx;
  let lastDecile = 0;
  for (const [index, frame] of frames.entries()) {
    const text = progressText(frame.done, frame.current, MOCK.toUpload);
    const isLast = index === frames.length - 1;
    if (out.tty) {
      out.write(`\r\x1b[K${text}`);
      if (ctx.animate) await sleep(180);
    } else {
      const decile = Math.floor((frame.done * 10) / MOCK.toUpload);
      if (decile > lastDecile || isLast) {
        line(out, text);
        lastDecile = decile;
      }
    }
    if (frame.note) {
      const sink = frame.note.sink === 'out' ? out : ctx.err;
      if (out.tty) out.write('\r\x1b[K');
      line(sink, frame.note.text(ctx));
    }
  }
  if (out.tty) out.write('\n');
}

async function backup(ctx: Ctx): Promise<number> {
  const { out, err, sym } = ctx;
  scanSummary(ctx);
  await runProgress(ctx, FRAMES);
  const uploaded = MOCK.uploadedBeforeQuota;
  const failed = 1;
  line(err);
  line(
    err,
    `${paint('red', sym.fail, err)} QUOTA_EXCEEDED: your Google Drive is full. ${fmtCount(uploaded)} of ${fmtCount(MOCK.toUpload)} files were uploaded and recorded.`,
  );
  line(
    err,
    '  Free up space or upgrade storage, then run the same command: it resumes where it stopped.',
  );
  line(out);
  line(
    out,
    `uploaded ${fmtCount(uploaded)}, skipped ${fmtCount(MOCK.unchanged)}, failed ${fmtCount(failed)}, remaining ${fmtCount(MOCK.toUpload - uploaded - failed)}`,
  );
  return 6;
}

async function backupInterrupted(ctx: Ctx): Promise<number> {
  const { err, sym } = ctx;
  scanSummary(ctx);
  await runProgress(ctx, [
    { done: 20, current: '2026/01/IMG_0102.HEIC' },
    { done: 37, current: '2026/02/IMG_0388.HEIC' },
  ]);
  line(err);
  line(
    err,
    `${paint('yellow', sym.warn, err)} Interrupted. 37 files were uploaded and recorded; 2 partial uploads were saved.`,
  );
  line(err, '  Run the same command to resume.');
  return 130;
}

const MISSING = 'Archive/2026-11/missing.pdf';

function error({ err, sym }: Ctx): number {
  line(err, `${paint('red', sym.fail, err)} NOT_FOUND: no file at ${MISSING}`);
  return 3;
}

function errorJson({ err }: Ctx): number {
  line(err, JSON.stringify({ code: 'NOT_FOUND', message: `no file at ${MISSING}` }));
  return 3;
}

const MOCK_SHA = '3f9a'.repeat(16);

function lsJson({ out }: Ctx): number {
  const entries = [
    {
      id: '1AbCmockFolder0001',
      name: 'receipts',
      path: 'Archive/2026-11/receipts',
      kind: 'folder',
      modifiedTime: '2026-11-03T12:00:00.000Z',
    },
    {
      id: '1AbCmockFile00001',
      name: 'statement.pdf',
      path: 'Archive/2026-11/statement.pdf',
      kind: 'file',
      size: 123456,
      modifiedTime: '2026-11-05T09:30:00.000Z',
      sha256: MOCK_SHA,
    },
    {
      id: '1AbCmockFile00002',
      name: 'invoice.pdf',
      path: 'Archive/2026-11/invoice.pdf',
      kind: 'file',
      size: 48210,
      modifiedTime: '2026-11-07T18:12:00.000Z',
      sha256: 'b71c'.repeat(16),
    },
  ];
  line(out, JSON.stringify(entries));
  return 0;
}

const FOLDER_ENTRY = {
  id: '1AbCmockFolder0001',
  name: '2026-11',
  path: 'Archive/2026-11',
  kind: 'folder',
  modifiedTime: '2026-11-03T12:00:00.000Z',
};

function statJson({ out }: Ctx): number {
  line(
    out,
    JSON.stringify({
      id: '1AbCmockFile00001',
      name: 'statement.pdf',
      path: 'Archive/2026-11/statement.pdf',
      kind: 'file',
      size: 123456,
      modifiedTime: '2026-11-05T09:30:00.000Z',
      sha256: MOCK_SHA,
    }),
  );
  return 0;
}

function mkdirJson({ out }: Ctx): number {
  line(out, JSON.stringify(FOLDER_ENTRY));
  return 0;
}

function rmJson({ out }: Ctx): number {
  line(out, JSON.stringify({ id: '1AbCmockFile00001', trashed: true }));
  return 0;
}

function backupDryRunJson({ out }: Ctx): number {
  line(
    out,
    JSON.stringify({
      found: 12431,
      unchanged: 11980,
      toUpload: ['2026/10/IMG_2988.HEIC', '2026/10/IMG_2989.HEIC'],
      bytes: MOCK.totalBytes,
      skipped: [
        { relPath: 'Thumbs.db', reason: 'system' },
        { relPath: '.hidden', reason: 'hidden' },
      ],
      warnings: [],
      errors: [],
    }),
  );
  return 0;
}

function putJson({ out }: Ctx): number {
  const result = {
    id: '1AbCmockFile00001',
    name: 'statement.pdf',
    sha256: MOCK_SHA,
    size: 123456,
    path: 'Archive/2026-11/statement.pdf',
  };
  line(out, JSON.stringify(result));
  return 0;
}

interface Scenario {
  name: string;
  command: string;
  title: string;
  json?: boolean;
  run: (ctx: Ctx) => number | Promise<number>;
}

const SCENARIOS: Scenario[] = [
  { name: 'auth', command: 'byos auth', title: 'Sign in', run: auth },
  { name: 'auth-status', command: 'byos auth status', title: 'Auth status', run: authStatus },
  { name: 'doctor', command: 'byos doctor', title: 'Doctor', run: doctor },
  {
    name: 'backup-dry-run',
    command: 'byos backup C:\\Users\\me\\Pictures --dry-run',
    title: 'Backup, dry run',
    run: backupDryRun,
  },
  {
    name: 'backup-dry-run-json',
    command: 'byos backup C:\\Users\\me\\Pictures --dry-run --json',
    title: 'Backup, dry run, JSON',
    json: true,
    run: backupDryRunJson,
  },
  {
    name: 'backup',
    command: 'byos backup C:\\Users\\me\\Pictures',
    title: 'Backup, stopped by a full Drive',
    run: backup,
  },
  {
    name: 'backup-interrupted',
    command: 'byos backup C:\\Users\\me\\Pictures   (then Ctrl+C)',
    title: 'Backup, interrupted',
    run: backupInterrupted,
  },
  {
    name: 'doctor-json',
    command: 'byos doctor --json',
    title: 'Doctor, JSON',
    json: true,
    run: doctorJson,
  },
  { name: 'error', command: `byos stat ${MISSING}`, title: 'Error', run: error },
  {
    name: 'error-json',
    command: `byos stat ${MISSING} --json`,
    title: 'Error under --json',
    json: true,
    run: errorJson,
  },
  {
    name: 'ls-json',
    command: 'byos ls Archive/2026-11 --json',
    title: 'ls --json',
    json: true,
    run: lsJson,
  },
  {
    name: 'stat-json',
    command: 'byos stat Archive/2026-11/statement.pdf --json',
    title: 'stat --json',
    json: true,
    run: statJson,
  },
  {
    name: 'mkdir-json',
    command: 'byos mkdir Archive/2026-11 --parents --json',
    title: 'mkdir --json',
    json: true,
    run: mkdirJson,
  },
  {
    name: 'rm-json',
    command: 'byos rm Archive/2026-11/statement.pdf --json',
    title: 'rm --json',
    json: true,
    run: rmJson,
  },
  {
    name: 'put-json',
    command: 'byos put ./statement.pdf --remote Archive/2026-11 --json',
    title: 'put --json',
    json: true,
    run: putJson,
  },
];

// ── markdown ───────────────────────────────────────────────────────────────

const EXIT_CODES: [number, string][] = [
  [0, 'success'],
  [
    1,
    'anything else (`PERMISSION_DENIED`, `PROVIDER_ERROR`, `UPLOAD_SESSION_EXPIRED`, a failed file in a backup)',
  ],
  [2, 'usage error'],
  [3, '`NOT_FOUND`'],
  [4, '`CONFLICT`'],
  [5, '`AUTH_FAILED` (doctor: a failing auth check)'],
  [6, '`QUOTA_EXCEEDED`'],
  [7, '`RATE_LIMITED` after retries'],
  [130, 'interrupted with Ctrl+C (backup saves its state first)'],
];

const ERROR_CODES: [string, string][] = [
  ['NOT_FOUND', 'the remote path or id does not exist'],
  ['CONFLICT', 'a file with that name already exists and overwrite was not asked for'],
  ['PERMISSION_DENIED', 'Drive refused access to that file'],
  [
    'AUTH_FAILED',
    'no token, an expired grant, a missing scope, or the 7-day Testing-mode expiry (`reason` tells which)',
  ],
  ['RATE_LIMITED', 'Drive asked to slow down; retried automatically before it is reported'],
  ['QUOTA_EXCEEDED', 'the Drive is full; never retried'],
  [
    'UPLOAD_SESSION_EXPIRED',
    'a resumable upload session expired; the next run starts that file again',
  ],
  ['PROVIDER_ERROR', 'any other Drive or network failure'],
];

function captureSink(): Sink & { text: () => string } {
  let buffer = '';
  return {
    tty: false,
    write: (text) => {
      buffer += text;
    },
    text: () => buffer,
  };
}

async function markdown(): Promise<string> {
  const parts: string[] = [];
  const p = (text = '') => parts.push(text);
  p('# CLI output');
  p();
  p(
    'What the `byos` CLI prints, decided before the commands exist. Generated by `node scripts/cli-output-mock.ts --markdown` from mock data; do not edit by hand. The outputs below are the plain form (piped, or `NO_COLOR` set).',
  );
  p();
  p('## Conventions');
  p();
  p('- Human output goes to stdout. Warnings and errors go to stderr.');
  p(
    '- `--json` prints exactly one JSON document on stdout on success, and exactly one `{ "code", "message" }` on stderr on failure. Nothing else: no color, no progress, no warnings.',
  );
  p(
    '- `byos auth --json` also prints the sign-in URL on stderr, as one plain line, because a person has to open it. Commands that need no person print nothing else.',
  );
  p(
    '- Color follows the terminal: none when the output is not a TTY or `NO_COLOR` is set, forced with `FORCE_COLOR`. Green success, yellow warning, red failure, cyan for URLs and paths, dim for secondary detail. Every status also has a symbol, so nothing depends on color alone.',
  );
  p(
    '- Symbols: `✓` ok, `!` warning, `✗` failure, `›` step, `…` waiting. The legacy Windows console (not Windows Terminal, not VS Code) gets `√ ! × > ...`, which its default font renders.',
  );
  p(
    '- Progress redraws one line in place on a TTY. Piped, it prints a plain line at every 10% and at the end.',
  );
  p('- Local paths print in the platform form; remote paths always use `/`.');
  p(
    '- `byos backup --dry-run --json` lists `toUpload` as relative paths (POSIX, NFC), `skipped` as `{ relPath, reason }` with the reason one of `system`, `hidden`, `symlink`, `excluded`, `not-regular` or `duplicate`, and `errors` as `{ relPath, code, message }`. The exit code is 1 when `errors` is not empty. A dry run reads the manifest but never writes to it, and creates no file.',
  );
  p(
    '- `byos backup --json` (a real run) prints one summary object on stdout, `{ uploaded, skipped, failed, remaining, stoppedBy?, failures }`, with `skipped` the files already backed up and unchanged, `stoppedBy` one of `quota`, `auth` or `interrupt`, and `failures` as `{ relPath, code, message }`. No progress is printed. When the run stops early the one-line error also goes to stderr (`QUOTA_EXCEEDED`, `AUTH_FAILED` or `INTERRUPTED`) and the exit code is 6, 5 or 130. Any failed file makes the exit code 1.',
  );
  p(
    '- `byos backup` runs up to `--concurrency` uploads at once (default 4, at most 16). It never deletes anything in Drive and never overwrites a file it did not create.',
  );
  p(
    '- A problem with the local disk (no permission, disk full, read-only) is `LOCAL_IO` with exit 1; a local path that does not exist or is not usable is `USAGE` with exit 2.',
  );
  p(
    '- In `--json` output `path` is present when the file was reached by path; a file reached by `id:<fileId>` has no `path`, because Drive ids carry none.',
  );
  p(
    '- `byos get` to stdout (no local path, or `-`) writes the raw bytes and can not be combined with `--json`. It never overwrites a local file without `--force`, and `byos put` never replaces a remote file without `--overwrite`; `byos rm` trashes unless `--permanent` is given.',
  );
  p(
    '- Counts use `,` thousands separators; sizes use binary units with one decimal (as Windows Explorer shows them).',
  );
  p('- English only in v1.');
  p();
  p('## Exit codes');
  p();
  p('| Code | Meaning |');
  p('|------|---------|');
  for (const [code, meaning] of EXIT_CODES) p(`| ${String(code)} | ${meaning} |`);
  p();
  p('## Error codes');
  p();
  for (const [code, meaning] of ERROR_CODES) p(`- \`${code}\`: ${meaning}`);
  for (const scenario of SCENARIOS) {
    const out = captureSink();
    const err = captureSink();
    const exit = await scenario.run({ out, err, sym: UNICODE, animate: false });
    const lang = scenario.json ? 'json' : 'text';
    p();
    p(`## ${scenario.title}`);
    p();
    p('```text');
    p(`$ ${scenario.command}`);
    p('```');
    for (const [label, sink] of [
      ['stdout', out],
      ['stderr', err],
    ] as const) {
      const text = sink.text();
      if (!text) continue;
      p();
      p(`${label}:`);
      p();
      p(`\`\`\`${lang}`);
      p(text.replace(/\n$/, ''));
      p('```');
    }
    p();
    p(`Exit code ${String(exit)}.`);
  }
  return `${parts.join('\n')}\n`;
}

// ── entry ──────────────────────────────────────────────────────────────────

function realSink(stream: NodeJS.WriteStream): Sink {
  return { tty: stream.isTTY, stream, write: (text) => stream.write(text) };
}

async function main(argv: string[]): Promise<number> {
  if (argv.includes('--markdown')) {
    process.stdout.write(await markdown());
    return 0;
  }
  const ascii = argv.includes('--ascii') || !supportsUnicode();
  const name = argv.find((arg) => !arg.startsWith('--'));
  const ctx: Ctx = {
    out: realSink(process.stdout),
    err: realSink(process.stderr),
    sym: ascii ? ASCII : UNICODE,
    animate: true,
  };
  if (name === 'all') {
    for (const scenario of SCENARIOS) {
      line(ctx.out, paint('dim', `${ctx.sym.rule} ${scenario.command} ${ctx.sym.rule}`, ctx.out));
      await scenario.run(ctx);
      line(ctx.out);
    }
    return 0;
  }
  const scenario = SCENARIOS.find((s) => s.name === name);
  if (!scenario) {
    line(ctx.err, `usage: node scripts/cli-output-mock.ts <scenario|all> [--ascii] | --markdown`);
    line(ctx.err, `scenarios: ${SCENARIOS.map((s) => s.name).join(', ')}`);
    return 2;
  }
  return scenario.run(ctx);
}

process.exitCode = await main(process.argv.slice(2));
