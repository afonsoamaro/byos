import { styleText } from 'node:util';

import type { CliIO, Sink } from './io.js';

// The PP-02 rules (docs/cli-output.md): human output on stdout, warnings and errors on stderr,
// `--json` prints one document on stdout and nothing else, color follows the terminal
// (util.styleText drops it for a pipe or NO_COLOR), and every status has a symbol.

type Format = Parameters<typeof styleText>[0];

export interface Symbols {
  readonly ok: string;
  readonly warn: string;
  readonly fail: string;
  readonly step: string;
  readonly wait: string;
}

const UNICODE: Symbols = { ok: '✓', warn: '!', fail: '✗', step: '›', wait: '…' };
// Characters from code page 437, which the legacy Windows console renders.
const ASCII: Symbols = { ok: '√', warn: '!', fail: '×', step: '>', wait: '...' };

/** Unicode unless this is the legacy Windows console (not Windows Terminal, not VS Code). */
export function supportsUnicode(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  if (platform !== 'win32') return true;
  return Boolean(env.WT_SESSION) || env.TERM_PROGRAM === 'vscode';
}

function paint(format: Format, text: string, sink: Sink): string {
  return sink.stream ? styleText(format, text, { stream: sink.stream }) : text;
}

export interface Output {
  readonly json: boolean;
  readonly sym: Symbols;
  ok(text: string): void;
  step(text: string): void;
  line(text?: string): void;
  rows(pairs: readonly (readonly [string, string])[], indent?: string): void;
  link(text: string): string;
  /** A line on stderr (human mode only), for the separators of a warning block. */
  errLine(text?: string): void;
  /** A warning on stderr, with an optional indented second line. */
  warn(text: string, detail?: string): void;
  /** An error on stderr, with an optional indented second line. */
  fail(text: string, detail?: string): void;
  /** Under `--json`, the single JSON document on stdout; otherwise nothing. */
  data(value: unknown): void;
  /** Under `--json`, the single `{ code, message }` on stderr. */
  jsonError(value: unknown): void;
}

export function createOutput(
  io: Pick<CliIO, 'out' | 'err' | 'env' | 'platform'>,
  options: { json: boolean },
): Output {
  const ascii = io.env.BYOS_ASCII === '1' || !supportsUnicode(io.platform, io.env);
  const sym = ascii ? ASCII : UNICODE;
  const human = !options.json;
  const write = (sink: Sink, text: string) => {
    if (human) sink.write(`${text}\n`);
  };
  return {
    json: options.json,
    sym,
    ok: (text) => {
      write(io.out, `${paint('green', sym.ok, io.out)} ${text}`);
    },
    step: (text) => {
      write(io.out, `${sym.step} ${text}`);
    },
    line: (text = '') => {
      write(io.out, text);
    },
    rows: (pairs, indent = '  ') => {
      const width = Math.max(0, ...pairs.map(([key]) => key.length));
      for (const [key, value] of pairs) {
        write(io.out, `${indent}${paint('dim', key.padEnd(width), io.out)}  ${value}`);
      }
    },
    link: (text) => paint('cyan', text, io.out),
    errLine: (text = '') => {
      write(io.err, text);
    },
    warn: (text, detail) => {
      write(io.err, `${paint('yellow', sym.warn, io.err)} ${text}`);
      if (detail) write(io.err, `  ${detail}`);
    },
    fail: (text, detail) => {
      write(io.err, `${paint('red', sym.fail, io.err)} ${text}`);
      if (detail) write(io.err, `  ${detail}`);
    },
    data: (value) => {
      if (options.json) io.out.write(`${JSON.stringify(value)}\n`);
    },
    jsonError: (value) => {
      if (options.json) io.err.write(`${JSON.stringify(value)}\n`);
    },
  };
}
