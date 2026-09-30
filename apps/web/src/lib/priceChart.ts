/**
 * A holding's price chart: the stored daily closes, and nothing else.
 *
 * The closes are the series the analysis rules read (the AI service builds
 * both), so the line a reader looks at is the one a finding was computed from.
 *
 * **Closed days are not gaps.** An exchange has no close on a weekend or a
 * holiday, so consecutive closes of an equity are normally one to four days
 * apart; drawing those as breaks would scatter the line into weekly fragments.
 * A break is drawn only where closes are further apart than any market closure
 * explains (`MAX_CLOSED_DAYS`) - a stretch where the price was not stored - so a
 * missing week reads as missing instead of as a straight line nobody measured.
 * Measured 2026-09-30: gaps between stored closes were 1-4 days, 5 once (a
 * holiday weekend on XETRA); so today the line never breaks.
 */

import type { DailyClose } from '@traders/shared';

/** The longest run of consecutive days a market is closed for, plus the day after. */
export const MAX_CLOSED_DAYS = 5;

export const RANGES = [
  { key: '1m', label: '1M', days: 30 },
  { key: '3m', label: '3M', days: 91 },
  { key: 'all', label: 'All', days: null },
] as const;

export type RangeKey = (typeof RANGES)[number]['key'];

export interface ChartPoint {
  /** The UTC calendar day, YYYY-MM-DD. */
  day: string;
  /** Null only on a break: a point that exists to stop the line. */
  priceMinor: number | null;
  asOf: string | null;
}

const DAY_MS = 86_400_000;

/** Whole days between two calendar dates, parsed at UTC midnight so no offset moves them. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** The closes within the range, counted back from the last close (not from today). */
export function inRange(closes: DailyClose[], range: RangeKey): DailyClose[] {
  const days = RANGES.find((option) => option.key === range)?.days ?? null;
  const last = closes[closes.length - 1];
  if (days === null || last === undefined) return closes;
  return closes.filter((close) => daysBetween(close.day, last.day) <= days);
}

/** Points to draw, oldest first, with a null point wherever the line must break. */
export function chartPoints(closes: DailyClose[]): ChartPoint[] {
  const points: ChartPoint[] = [];
  closes.forEach((close, index) => {
    const previous = closes[index - 1];
    if (previous && daysBetween(previous.day, close.day) > MAX_CLOSED_DAYS) {
      points.push({ day: previous.day, priceMinor: null, asOf: null });
    }
    points.push({ day: close.day, priceMinor: close.priceMinor, asOf: close.asOf });
  });
  return points;
}

/** Stretches of more than `MAX_CLOSED_DAYS` with no stored close. */
export function missingStretches(closes: DailyClose[]): number {
  return closes.filter(
    (close, index) => index > 0 && daysBetween(closes[index - 1]!.day, close.day) > MAX_CLOSED_DAYS,
  ).length;
}

export interface RangeChange {
  from: DailyClose;
  to: DailyClose;
  changeMinor: number;
  /** Percent, for display. Null when the two closes are in different currencies. */
  changePct: number | null;
}

/** First close to last close of the range. Money stays in integer minor units. */
export function rangeChange(closes: DailyClose[]): RangeChange | null {
  const from = closes[0];
  const to = closes[closes.length - 1];
  if (!from || !to || from === to || from.currency !== to.currency) return null;
  const changeMinor = to.priceMinor - from.priceMinor;
  return { from, to, changeMinor, changePct: (changeMinor / from.priceMinor) * 100 };
}

/**
 * True when `day` is today in UTC: the series' last point is then the latest
 * observation of a day still trading (or not yet open), not a close. The rules
 * read it the same way - it is labelled, not dropped.
 */
export function isOpenDay(day: string, now: Date = new Date()): boolean {
  return day === now.toISOString().slice(0, 10);
}

/** A day as the chart names it: the date, or "so far today" for a day not yet closed. */
export function dayName(day: string, now: Date = new Date()): string {
  return isOpenDay(day, now) ? `${formatDay(day)} (so far today)` : formatDay(day);
}

/** Where a price level sits against the closes drawn: on the chart, or off one edge. */
export function levelPosition(levelMinor: number, closes: DailyClose[]): 'within' | 'below' | 'above' {
  const prices = closes.map((close) => close.priceMinor);
  if (prices.length === 0) return 'within';
  if (levelMinor < Math.min(...prices)) return 'below';
  if (levelMinor > Math.max(...prices)) return 'above';
  return 'within';
}

/** What the chart's caption says about its own coverage. */
export function coverageText(closes: DailyClose[]): string {
  if (closes.length === 0) {
    return 'No stored closing price yet. The daily history run fills it; nothing is fetched to draw this chart.';
  }
  const first = closes[0]!;
  const last = closes[closes.length - 1]!;
  const parts = [
    `${closes.length} daily close${closes.length === 1 ? '' : 's'} from ${formatDay(first.day)} to ${formatDay(last.day)}`,
    'stored prices only',
  ];
  const missing = missingStretches(closes);
  if (missing > 0) {
    parts.push(
      `${missing} stretch${missing === 1 ? '' : 'es'} with no stored price ${missing === 1 ? 'is a break' : 'are breaks'} in the line`,
    );
  }
  return `${parts.join('; ')}.`;
}

const dayLabel = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/** A calendar day, formatted in UTC so no timezone moves it. */
export function formatDay(day: string): string {
  return dayLabel.format(new Date(`${day}T00:00:00Z`));
}
