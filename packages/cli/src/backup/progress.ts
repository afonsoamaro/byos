import { posix } from 'node:path';

import { formatBytes, printable } from '../format.js';
import type { Sink } from '../io.js';

// The PP-02 progress rules (docs/cli-output.md): one line redrawn in place on a TTY, and a plain
// line at every 10% of the files (and at the end) when the output is piped.

export interface ProgressOptions {
  readonly sink: Sink;
  /** False under `--json`: nothing is drawn. */
  readonly enabled: boolean;
  readonly total: number;
  readonly totalBytes: number;
  readonly now: () => number;
}

/** Redraws are throttled to this, so a fast upload doesn't flood the terminal. */
const REDRAW_MS = 100;
const CLEAR_LINE = '\r\x1b[K';

export class Progress {
  readonly #options: ProgressOptions;
  readonly #startedAt: number;
  /** Bytes confirmed so far for uploads still running, by file name (the provider's key). */
  readonly #running = new Map<string, number>();
  #settled = 0;
  #doneBytes = 0;
  #current = '';
  #lastDecile = 0;
  #lastDraw = Number.NEGATIVE_INFINITY;
  #drawn = false;

  constructor(options: ProgressOptions) {
    this.#options = options;
    this.#startedAt = options.now();
  }

  started(relPath: string): void {
    this.#current = relPath;
    this.#redraw();
  }

  /** Bytes Drive confirmed for a running upload (the provider's `onUploadProgress`). */
  bytes(name: string, confirmed: number): void {
    this.#running.set(name, confirmed);
    this.#redraw();
  }

  finished(relPath: string, size: number): void {
    this.#running.delete(posix.basename(relPath));
    this.#doneBytes += size;
    this.#settle(relPath);
  }

  failed(relPath: string): void {
    this.#running.delete(posix.basename(relPath));
    this.#settle(relPath);
  }

  /** Runs `write` (a warning or an error line) without leaving it glued to the progress line. */
  interject(write: () => void): void {
    if (this.#options.enabled && this.#options.sink.tty && this.#drawn) {
      this.#options.sink.write(CLEAR_LINE);
    }
    write();
  }

  /** Ends the redrawn line, so what is printed next starts on a fresh one. */
  end(): void {
    if (this.#options.enabled && this.#options.sink.tty && this.#drawn) {
      this.#options.sink.write('\n');
      this.#drawn = false;
    }
  }

  #settle(relPath: string): void {
    this.#settled += 1;
    this.#current = relPath;
    if (!this.#options.enabled) return;
    if (this.#options.sink.tty) {
      this.#draw();
      return;
    }
    const decile = Math.floor((this.#settled * 10) / Math.max(1, this.#options.total));
    if (decile > this.#lastDecile || this.#settled === this.#options.total) {
      this.#lastDecile = decile;
      this.#options.sink.write(`${this.#text()}\n`);
    }
  }

  #redraw(): void {
    if (!this.#options.enabled || !this.#options.sink.tty) return;
    if (this.#options.now() - this.#lastDraw < REDRAW_MS) return;
    this.#draw();
  }

  #draw(): void {
    this.#lastDraw = this.#options.now();
    this.#drawn = true;
    this.#options.sink.write(`${CLEAR_LINE}${this.#text()}`);
  }

  #text(): string {
    let bytes = this.#doneBytes;
    for (const confirmed of this.#running.values()) bytes += confirmed;
    const seconds = Math.max(0.001, (this.#options.now() - this.#startedAt) / 1000);
    const width = String(this.#options.total).length;
    const files = `${String(this.#settled).padStart(width)}/${String(this.#options.total)}`;
    return `[ ${files} ]  ${formatBytes(bytes)} / ${formatBytes(this.#options.totalBytes)}  ${formatBytes(bytes / seconds)}/s  ${printable(this.#current)}`;
  }
}
