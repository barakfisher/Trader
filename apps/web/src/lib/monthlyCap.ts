/**
 * When a user's monthly limit starts again - their safety limit (D250), and the
 * retired cap (D157) before it: the first day of the
 * calendar month after a moment, in the user's zone - the same month the AI
 * service enforces. A refused scan or question names the month it was refused
 * in, so the date comes from when it happened, not from today.
 */

import { formatDate } from '../i18n/format.ts';
import { getDisplayTimeZone } from './relativeTime.ts';

/** `YYYY-MM-DD`: the first day of the month after `at`, in the user's zone. */
export function capResetsOn(at: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: getDisplayTimeZone(),
    year: 'numeric',
    month: 'numeric',
  }).formatToParts(at);
  const year = Number(parts.find((part) => part.type === 'year')?.value);
  const month = Number(parts.find((part) => part.type === 'month')?.value);
  const [nextYear, nextMonth] = month === 12 ? [year + 1, 1] : [year, month + 1];
  return `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;
}

/** A local `YYYY-MM-DD` date, "1 November 2026", in the interface's language. */
export function formatResetDate(localDate: string): string {
  const [year, month, day] = localDate.split('-').map(Number);
  // A calendar date, not a moment: printed in UTC so no zone can move its day.
  return formatDate(new Date(Date.UTC(year!, month! - 1, day!)), {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/** The reset date of a cap reached at `at` (an ISO timestamp, or now), ready to show. */
export function capResetLabel(at: string | null = null): string {
  return formatResetDate(capResetsOn(at === null ? new Date() : new Date(at)));
}
