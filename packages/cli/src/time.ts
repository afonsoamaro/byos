export const DAY_MS = 24 * 60 * 60 * 1000;

const UNITS: readonly (readonly [string, number])[] = [
  ['day', DAY_MS],
  ['hour', 60 * 60 * 1000],
  ['minute', 60 * 1000],
];

/** "3 days ago", "in 52 minutes", "just now": the distance between two instants, in words. */
export function relativeTime(thenMs: number, nowMs: number): string {
  const diff = thenMs - nowMs;
  const abs = Math.abs(diff);
  for (const [unit, size] of UNITS) {
    if (abs >= size) {
      const count = Math.floor(abs / size);
      const text = `${String(count)} ${unit}${count === 1 ? '' : 's'}`;
      return diff < 0 ? `${text} ago` : `in ${text}`;
    }
  }
  return 'just now';
}

/** Whole days between two instants (never negative). */
export function wholeDays(fromMs: number, toMs: number): number {
  return Math.max(0, Math.floor((toMs - fromMs) / DAY_MS));
}

/** `2026-11-12`, in UTC. */
export function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** "5 minutes", "30 seconds": a duration for a message. */
export function describeDuration(ms: number): string {
  if (ms >= 60_000) {
    const minutes = Math.round(ms / 60_000);
    return `${String(minutes)} minute${minutes === 1 ? '' : 's'}`;
  }
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  return `${String(seconds)} second${seconds === 1 ? '' : 's'}`;
}
