import { QuotaExceededError } from '@byos/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliIO } from '../../src/io.js';
import { main } from '../../src/main.js';
import { cleanup, harness } from '../helpers.js';
import { cleanupBackup, tmp, write } from './fixtures.js';
import { ResumableMemory } from './resumable-memory.js';

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('real fetch called: the backup tests use an in-memory provider');
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await cleanup();
  await cleanupBackup();
});

const names = (n: number): Record<string, string> =>
  Object.fromEntries(
    Array.from({ length: n }, (_, i) => [`d${String(i % 3)}/f${String(i)}.txt`, `c${String(i)}`]),
  );

async function setup(files: Record<string, string>, provider = new ResumableMemory()) {
  const t = await harness({ memory: provider });
  const folder = await tmp();
  await write(folder, files);
  const run = (...args: string[]) => main(['backup', folder, '--device', 'laptop', ...args], t.io);
  return { t, folder, provider, run };
}

describe('byos backup', () => {
  it('uploads, prints the PP-02 summary, and a second run has nothing to do', async () => {
    const { t, provider, run } = await setup(names(12));
    expect(await run()).toBe(0);
    const out = t.stdout();
    expect(out).toMatch(/^ {2}12 to upload \(\d+ B\)$/m);
    expect(out).toMatch(/^ {2}remote BYOS Backup\/laptop\/[^/\n]+$/m);
    // Piped, not redrawn: plain progress lines, the last one at 12/12.
    expect(out).toMatch(/^\[ 12\/12 \] {2}\d+ B \/ \d+ B {2}.+\/s {2}\S+$/m);
    expect(out).not.toContain('\r');
    expect(out).toContain('uploaded 12, skipped 0, failed 0, remaining 0');
    expect(t.stderr()).toBe('');
    expect(provider.inner.snapshot().filter((e) => !e.isFolder)).toHaveLength(12);

    const puts = provider.calls.put;
    expect(await run()).toBe(0);
    expect(t.stdout()).toContain('Nothing to upload.');
    expect(t.stdout()).toContain('uploaded 0, skipped 12, failed 0, remaining 0');
    expect(provider.calls.put).toBe(puts);
    expect(provider.calls.delete).toBe(0);
  });

  it('with --json prints only the summary object', async () => {
    const { t, run } = await setup(names(5));
    expect(await run('--json')).toBe(0);
    const lines = t.stdout().trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      uploaded: 5,
      skipped: 0,
      failed: 0,
      remaining: 0,
      failures: [],
    });
    expect(t.stderr()).toBe('');
  });

  it('exits 1 and names a failed file, while the run continues', async () => {
    const { t, provider, run } = await setup({ 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' });
    provider.inner.failNext('put', new Error('boom: secret detail'));
    expect(await run('--concurrency', '1')).toBe(1);
    expect(t.stderr()).toMatch(
      /UNEXPECTED: unexpected error \(Error\) \(file skipped, run continues\)/,
    );
    expect(t.stderr()).not.toContain('secret detail');
    expect(t.stdout()).toContain('uploaded 2, skipped 0, failed 1, remaining 0');
  });

  it('lists failures in the --json summary', async () => {
    const { t, provider, run } = await setup({ 'a.txt': 'a' });
    provider.inner.failNext('put', new Error('boom'));
    expect(await run('--json')).toBe(1);
    const summary = JSON.parse(t.stdout()) as { failed: number; failures: unknown[] };
    expect(summary.failed).toBe(1);
    expect(summary.failures).toEqual([
      { relPath: 'a.txt', code: 'UNEXPECTED', message: 'unexpected error (Error)' },
    ]);
  });

  describe('stops', () => {
    const files = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`f${String(i)}.txt`, `c${String(i)}`]),
    );

    function failOnFourthPut(provider: ResumableMemory): void {
      let puts = 0;
      provider.gate = () => {
        puts += 1;
        if (puts === 4) provider.inner.failNext('put', new QuotaExceededError('full'));
        return Promise.resolve();
      };
    }

    it('stops on a full Drive with exit 6 and the PP-02 message', async () => {
      const { t, provider, run } = await setup(files);
      failOnFourthPut(provider);
      expect(await run('--concurrency', '1')).toBe(6);
      expect(t.stderr()).toContain(
        'QUOTA_EXCEEDED: your Google Drive is full. 3 of 10 files were uploaded and recorded.',
      );
      expect(t.stderr()).toContain(
        'Free up space or upgrade storage, then run the same command: it resumes where it stopped.',
      );
      expect(t.stdout()).toContain('uploaded 3, skipped 0, failed 0, remaining 7');
      provider.gate = undefined;
      expect(await run()).toBe(0);
      expect(t.stdout()).toContain('uploaded 7, skipped 3, failed 0, remaining 0');
    });

    it('reports a full Drive as one error line on stderr and the summary on stdout in --json', async () => {
      const { t, provider, run } = await setup(files);
      failOnFourthPut(provider);
      expect(await run('--concurrency', '1', '--json')).toBe(6);
      expect(JSON.parse(t.stderr())).toEqual({
        code: 'QUOTA_EXCEEDED',
        message: 'your Google Drive is full. 3 of 10 files were uploaded and recorded.',
      });
      expect(JSON.parse(t.stdout())).toMatchObject({
        uploaded: 3,
        remaining: 7,
        stoppedBy: 'quota',
      });
    });

    it('on Ctrl+C saves its state, says how to resume, and exits 130', async () => {
      const { t, provider, run } = await setup(files);
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      provider.gate = () => held;
      const running = run('--concurrency', '2');
      await vi.waitFor(() => {
        expect(provider.calls.put).toBe(2);
      });
      t.interrupt();
      release();
      expect(await running).toBe(130);
      expect(t.stderr()).toContain(
        'Interrupted. 2 files were uploaded and recorded; 0 partial uploads were saved.',
      );
      expect(t.stderr()).toContain('Run the same command to resume.');
      expect(t.stdout()).not.toContain('uploaded 2,');
      provider.gate = undefined;
      expect(await run()).toBe(0);
      expect(provider.inner.snapshot().filter((e) => !e.isFolder)).toHaveLength(10);
      expect(provider.calls.delete).toBe(0);
    });
  });

  describe('--concurrency', () => {
    it('honors 16 and clamps 20 down to it', async () => {
      const many = Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [`f${String(i)}.txt`, String(i)]),
      );
      const { provider, run } = await setup(many);
      provider.gate = () => new Promise((resolve) => setTimeout(resolve, 5));
      expect(await run('--concurrency', '20')).toBe(0);
      expect(provider.maxInFlight).toBe(16);
    });

    it('refuses a value that is not a whole number of 1 or more (exit 2)', async () => {
      const { t, provider, run } = await setup({ 'a.txt': 'a' });
      expect(await run('--concurrency', '0')).toBe(2);
      expect(await run('--concurrency', 'many')).toBe(2);
      expect(await run('--concurrency', '2.5')).toBe(2);
      expect(t.stderr()).toContain('--concurrency needs a whole number');
      expect(provider.calls.put).toBe(0);
    });
  });

  it('redraws one line on a terminal', async () => {
    const { t, folder, provider } = await setup(names(4));
    let text = '';
    const io: CliIO = {
      ...t.io,
      out: { tty: true, write: (chunk) => (text += chunk) },
    };
    expect(await main(['backup', folder, '--device', 'laptop'], io)).toBe(0);
    expect(text).toContain('\r\x1b[K[ 4/4 ]');
    // The redrawn line is ended before the summary starts on a new line.
    expect(text).toMatch(/\[ 4\/4 \].*\n\nuploaded 4, skipped 0, failed 0, remaining 0\n$/);
    expect(provider.calls.delete).toBe(0);
  });
});
