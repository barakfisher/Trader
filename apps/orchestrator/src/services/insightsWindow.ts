/**
 * The days the Insights page shows (decision 133): today in the user's own
 * timezone (guideline 10), then back one day at a time, at most seven days in
 * all. Older findings are not deleted - nothing deletes observations except
 * `reset_account` - they are only outside what the page steps through.
 *
 * Computed here, once, and sent to the page with each day's counts, so the
 * browser never does its own timezone arithmetic and cannot disagree with the
 * server about which day "today" is.
 */

import { localDate } from './snapshot.js';

/** How many days, today included, the page steps back through. */
export const INSIGHTS_DAYS = 7;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `day` (YYYY-MM-DD) moved by `offset` calendar days. Calendar arithmetic, no zone. */
export function shiftDay(day: string, offset: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

/** The window's days, today first, as local dates in `timezone`. */
export function windowDays(timezone: string, now: Date = new Date()): string[] {
  const today = localDate(timezone, now);
  return Array.from({ length: INSIGHTS_DAYS }, (_, index) => shiftDay(today, -index));
}

/** Whether `day` is a date the page may ask for: well-formed and inside the window. */
export function isWindowDay(day: string, timezone: string, now: Date = new Date()): boolean {
  return ISO_DAY.test(day) && windowDays(timezone, now).includes(day);
}
