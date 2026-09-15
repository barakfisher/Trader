/**
 * Daily portfolio snapshot.
 *
 * One row per user per day, keyed on the date in the user's own timezone (Israel
 * time by default) so "today" means what the user means by today. Re-running the
 * job overwrites the row instead of appending, which makes the job safely
 * repeatable - the same property the scheduled runs rely on in M4.
 *
 * Each row also records how complete its pricing was, because the stored series
 * is what M2 computes volatility and drawdown from and it is never recomputed.
 */

import { AiClient } from '@traders/shared/ai';

import { listHoldings, upsertSnapshot, type UserRow } from '../db/queries.js';
import { logger } from '../logger.js';
import { valuePortfolio } from './valuation.js';

/** Current date in a given IANA timezone, as YYYY-MM-DD. */
export function localDate(timezone: string, now: Date = new Date()): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(now);
}

export interface SnapshotResult {
  asOf: string;
  totalMinor: number;
  costMinor: number;
  currency: string;
  holdings: number;
  /** Holdings that contributed a price to `totalMinor`. */
  pricedCount: number;
  /** True when the stored total is approximate: something unpriced or stale. */
  degraded: boolean;
  skipped: boolean;
  reason?: string;
}

export async function takeSnapshot(user: UserRow, ai: AiClient, requestId?: string): Promise<SnapshotResult> {
  const asOf = localDate(user.timezone);
  const rows = await listHoldings(user.id);

  if (rows.length === 0) {
    return {
      asOf,
      totalMinor: 0,
      costMinor: 0,
      currency: user.base_currency,
      holdings: 0,
      pricedCount: 0,
      degraded: false,
      skipped: true,
      reason: 'no holdings',
    };
  }

  const portfolio = await valuePortfolio(rows, {
    baseCurrency: user.base_currency,
    ai,
    requestId,
  });

  const { holdingsCount, pricedCount, degraded } = portfolio.summary;

  // Nothing priced means there is no measurement to store at all - writing a
  // total of zero would be the invention guideline 7 forbids.
  if (pricedCount === 0) {
    logger().warn({ userId: user.id, asOf }, 'snapshot skipped: no holding could be priced');
    return {
      asOf,
      totalMinor: 0,
      costMinor: 0,
      currency: user.base_currency,
      holdings: rows.length,
      pricedCount: 0,
      degraded: true,
      skipped: true,
      reason: 'no holding could be priced',
    };
  }

  // A partially priced portfolio IS stored, marked. Refusing to write would leave
  // a gap in the series, and a gap is read as "no change since the last point",
  // which is just as misleading as an understated total - both invent a move that
  // did not happen. Storing the row with its counts and `degraded` flag keeps the
  // day present and lets every consumer (M2's volatility and drawdown rules
  // first) exclude it instead of explaining a phantom crash. Snapshots are never
  // recomputed, so the marker is the only chance to say the total is incomplete.
  await upsertSnapshot({
    userId: user.id,
    asOf,
    totalMinor: portfolio.summary.totalValueMinor,
    costMinor: portfolio.summary.totalCostMinor,
    currency: portfolio.summary.baseCurrency,
    breakdown: portfolio.holdings.map((holding) => ({
      symbol: holding.instrument.symbol,
      quantity: holding.quantity,
      valueMinor: holding.valueMinor,
      weightPct: holding.weightPct,
    })),
    holdingsCount,
    pricedCount,
    degraded,
  });

  const written = {
    userId: user.id,
    asOf,
    totalMinor: portfolio.summary.totalValueMinor,
    holdingsCount,
    pricedCount,
    degraded,
  };
  if (degraded) {
    logger().warn(
      { ...written, unpricedSymbols: portfolio.summary.unpricedSymbols },
      'snapshot written from incomplete prices; total is understated',
    );
  } else {
    logger().info(written, 'snapshot written');
  }

  return {
    asOf,
    totalMinor: portfolio.summary.totalValueMinor,
    costMinor: portfolio.summary.totalCostMinor,
    currency: portfolio.summary.baseCurrency,
    holdings: rows.length,
    pricedCount,
    degraded,
    skipped: false,
  };
}
