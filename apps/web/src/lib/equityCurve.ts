/**
 * The equity curve: one point per calendar day between the first snapshot and
 * the last, from the daily snapshots the server stored - and nothing else.
 *
 * **A day without a snapshot is a gap, never an estimate** (the user's decision,
 * 2026-09-29). The laptop this runs on sleeps, so the daily run is missed on
 * some days; drawing a line across those days would claim a value nobody
 * measured. Synthesising history from quotes was rejected for the same reason:
 * it would be "what today's holdings would have been worth", which is not the
 * account's history.
 *
 * **A degraded snapshot is drawn, and marked.** One with unpriced holdings or
 * stale quotes understates the total; hiding it would hide that the day
 * happened, and drawing it plain would present an understatement as a fact.
 */

import type { PortfolioSnapshot } from '@traders/shared';

export interface CurvePoint {
  /** Calendar date, YYYY-MM-DD, as the snapshot states it. */
  date: string;
  /** Null on a day with no snapshot: a gap in the line. */
  totalMinor: number | null;
  costMinor: number | null;
  degraded: boolean;
  pricedCount: number | null;
  holdingsCount: number | null;
}

const DAY_MS = 86_400_000;

/** Calendar arithmetic on dates as dates: parsed at UTC midnight, so no timezone moves a day. */
function nextDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
}

/** Every calendar day from the first snapshot to the last, oldest first. */
export function curvePoints(snapshots: PortfolioSnapshot[]): CurvePoint[] {
  if (snapshots.length === 0) return [];
  const byDate = new Map(snapshots.map((snapshot) => [snapshot.asOf, snapshot]));
  const dates = [...byDate.keys()].sort();
  const last = dates[dates.length - 1]!;
  const points: CurvePoint[] = [];
  for (let date = dates[0]!; date <= last; date = nextDay(date)) {
    const snapshot = byDate.get(date);
    points.push(
      snapshot
        ? {
            date,
            totalMinor: snapshot.totalMinor,
            costMinor: snapshot.costMinor,
            degraded: snapshot.degraded,
            pricedCount: snapshot.pricedCount,
            holdingsCount: snapshot.holdingsCount,
          }
        : {
            date,
            totalMinor: null,
            costMinor: null,
            degraded: false,
            pricedCount: null,
            holdingsCount: null,
          },
    );
  }
  return points;
}

/** What the chart's caption says about its own coverage. */
export function coverageText(points: CurvePoint[]): string {
  const measured = points.filter((point) => point.totalMinor !== null);
  if (measured.length === 0) return 'No daily snapshot yet. The first is taken by the daily close run.';
  const days = points.length;
  const degraded = measured.filter((point) => point.degraded).length;
  const parts = [
    `${measured.length} daily snapshot${measured.length === 1 ? '' : 's'} over ${days} day${days === 1 ? '' : 's'}`,
  ];
  if (measured.length < days) parts.push('days without one are gaps, not estimates');
  if (degraded > 0) {
    parts.push(
      `${degraded} ${degraded === 1 ? 'is' : 'are'} marked: some holdings were unpriced or stale, so the total is understated`,
    );
  }
  return `${parts.join('; ')}.`;
}
