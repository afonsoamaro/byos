const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** Binary units with one decimal, labeled the way Windows Explorer shows them. */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${String(bytes)} B` : `${value.toFixed(1)} ${UNITS[unit] ?? 'B'}`;
}

/**
 * Text that came from a remote file name, made safe to print on a terminal: control characters
 * (including ESC, which starts a terminal escape sequence) become `?`. Human output only; JSON
 * output is escaped by `JSON.stringify` and keeps the real name.
 */
export function printable(text: string): string {
  return Array.from(text, (char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 32 || (code >= 127 && code <= 159) ? '?' : char;
  }).join('');
}
