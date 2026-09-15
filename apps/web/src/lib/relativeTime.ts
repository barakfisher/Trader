/**
 * Human-readable ages for timestamps.
 *
 * Used to show how old a price is, which this dashboard has to be honest about:
 * quotes come from a delayed feed and are dated to the provider's observation
 * window, so "now" is almost never the right answer.
 */

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Whole seconds between `iso` and `now`. Negative values (clock skew) clamp to 0. */
export function ageInSeconds(iso: string, now: Date = new Date()): number {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 0;
  return Math.max(0, Math.floor((now.getTime() - then) / 1000));
}

/**
 * A short age label: "just now", "12m ago", "3h ago", "2d ago".
 *
 * Deliberately coarse. Displaying "14m 37s ago" for a price that is only
 * accurate to a 15-minute window would imply a precision the data does not have.
 */
export function formatAge(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '—';
  const seconds = ageInSeconds(iso, now);
  if (seconds < MINUTE) return 'just now';
  if (seconds < HOUR) return `${Math.floor(seconds / MINUTE)}m ago`;
  if (seconds < DAY) return `${Math.floor(seconds / HOUR)}h ago`;
  return `${Math.floor(seconds / DAY)}d ago`;
}

/** Full timestamp for a tooltip, in the viewer's own locale and timezone. */
export function formatExactTime(iso: string | null | undefined): string {
  if (!iso) return 'unknown';
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? 'unknown' : parsed.toLocaleString();
}
