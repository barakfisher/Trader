/**
 * The Insights window's days as the page shows them (decision 133). The days
 * themselves come from the server, which knows the user's timezone; this only
 * picks one, names it, and says whether a finding is unread.
 */

import type { InsightsDaysResponse } from '@traders/shared';

import { t } from '../i18n/index.ts';
import { formatDate } from '../i18n/format.ts';

type Day = InsightsDaysResponse['days'][number];

/**
 * The day the feed shows: the one the address names when it is in the window,
 * else today. A link to a day that has since left the window is today, not an
 * error page.
 */
export function dayInWindow(days: Day[], requested: string | undefined): string | undefined {
  if (requested !== undefined && days.some((day) => day.day === requested)) return requested;
  return days[0]?.day;
}

/** "Today", "Yesterday", or the weekday and date, in the page language. */
export function dayLabel(days: Day[], day: string): string {
  const index = days.findIndex((entry) => entry.day === day);
  if (index === 0) return t('feed.days.today');
  if (index === 1) return t('feed.days.yesterday');
  // A calendar date with no time: formatted at UTC midnight so no zone moves it.
  return formatDate(new Date(`${day}T00:00:00Z`), {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

/** The most recent day before `day` that has findings, for an empty day's pointer. */
export function latestEarlierDay(days: Day[], day: string): Day | undefined {
  const index = days.findIndex((entry) => entry.day === day);
  return days.slice(index + 1).find((entry) => entry.count > 0);
}

/**
 * Whether a finding is unread, judged against `seenAt` as it was when the page
 * opened (the user, 2026-10-11): a visit marks findings seen, and they stay
 * highlighted for the rest of that visit. Null is "nothing seen yet".
 */
export function isUnread(createdAt: string, seenAt: string | null): boolean {
  return seenAt === null || Date.parse(createdAt) > Date.parse(seenAt);
}
