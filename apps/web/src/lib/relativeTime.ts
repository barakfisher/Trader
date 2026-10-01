/**
 * Human-readable ages for timestamps.
 *
 * Used to show how old a price is, which this dashboard has to be honest about:
 * quotes come from a delayed feed and are dated to the provider's observation
 * window, so "now" is almost never the right answer.
 */

import { formatDate } from '../i18n/format.ts';
import { t } from '../i18n/index.ts';

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
  if (seconds < MINUTE) return t('age.justNow');
  if (seconds < HOUR) return t('age.ago', { duration: t('duration.minutes', { count: Math.floor(seconds / MINUTE) }) });
  if (seconds < DAY) return t('age.ago', { duration: t('duration.hours', { count: Math.floor(seconds / HOUR) }) });
  return t('age.ago', { duration: t('duration.days', { count: Math.floor(seconds / DAY) }) });
}

/**
 * The timezone exact times are shown in: the user's own (`users.timezone`,
 * `APP_TIMEZONE` by default), set when a session starts.
 *
 * Until M6 PR 13 every time was printed in whatever zone and locale the browser
 * had - right on this machine only because it happens to sit in Asia/Jerusalem,
 * and "9/28/2026, 1:18:01 PM" in US order besides. Guideline 10: "today"
 * resolves in the user's timezone, and a time shown beside a "today" figure has
 * to be in the same one. Module state rather than a context, because thirty
 * call sites format a time and none of them is otherwise a component concern;
 * the router renders nothing until the session - and so the zone - is known.
 */
let displayTimeZone: string | null = null;

/** Set from the signed-in user; null (signed out) falls back to UTC, which is named on screen. */
export function setDisplayTimeZone(zone: string | null): void {
  displayTimeZone = zone && isValidTimeZone(zone) ? zone : null;
}

export function getDisplayTimeZone(): string {
  return displayTimeZone ?? 'UTC';
}

function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function formatIn(parsed: Date, options: Intl.DateTimeFormatOptions): string {
  return formatDate(parsed, { timeZone: getDisplayTimeZone(), ...options });
}

/**
 * A full timestamp for a tooltip or a record: "28 Sept 2026, 13:18:01 GMT+3". Day
 * first and a 24-hour clock, in the user's timezone, with the zone named - a
 * time without its zone is a guess the reader has to make.
 */
export function formatExactTime(iso: string | null | undefined): string {
  if (!iso) return t('common.unknown');
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return t('common.unknown');
  return formatIn(parsed, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  });
}

/** A clock time for "saved 13:18" and "fetched 13:18": the same zone, no date. */
export function formatClockTime(when: Date | string | number): string {
  const parsed = new Date(when);
  if (Number.isNaN(parsed.getTime())) return t('common.unknown');
  return formatIn(parsed, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}
