/**
 * Daily portfolio snapshot.
 *
 * One row per user per day, keyed on the date in the user's own timezone (Israel
 * time by default) so "today" means what the user means by today. Re-running the
 * job overwrites the row instead of appending, which makes the job safely
 * repeatable - the same property the scheduled runs rely on in M4.
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
      skipped: true,
      reason: 'no holdings',
    };
  }

  const portfolio = await valuePortfolio(rows, {
    baseCurrency: user.base_currency,
    ai,
    requestId,
  });

  // A snapshot that silently records a partially priced portfolio would corrupt
  // the equity curve, so refuse rather than store a misleading number.
  if (portfolio.summary.pricedCount === 0) {
    logger().warn({ userId: user.id, asOf }, 'snapshot skipped: no holding could be priced');
    return {
      asOf,
      totalMinor: 0,
      costMinor: 0,
      currency: user.base_currency,
      holdings: rows.length,
      skipped: true,
      reason: 'no holding could be priced',
    };
  }

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
  });

  logger().info(
    { userId: user.id, asOf, totalMinor: portfolio.summary.totalValueMinor, degraded: portfolio.summary.degraded },
    'snapshot written',
  );

  return {
    asOf,
    totalMinor: portfolio.summary.totalValueMinor,
    costMinor: portfolio.summary.totalCostMinor,
    currency: portfolio.summary.baseCurrency,
    holdings: rows.length,
    skipped: false,
  };
}
