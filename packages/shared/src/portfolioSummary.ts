import type { PortfolioSummary } from './types.js';

/**
 * Several portfolio summaries as one: the simulated agents together, or the
 * real portfolio and the agents together under *All* (D231).
 *
 * Every figure is a sum of integer minor units, and each keeps the rule its
 * parts were computed by: cost and P&L cover only holdings with a price and a
 * cost basis (D230), a day change only parts that have one, and a symbol that
 * is unpriced or uncosted anywhere is named. A percentage is computed again
 * from the sums - never averaged - so it is exactly what a single summary of
 * all the holdings would say.
 *
 * All summaries must be in `baseCurrency`; agents are USD-only (D7) and so is
 * the base currency (guideline 10), so nothing here converts.
 */
export function combineSummaries(baseCurrency: string, summaries: PortfolioSummary[], asOf: string): PortfolioSummary {
  const totalValueMinor = sum(summaries.map((summary) => summary.totalValueMinor));
  const totalCostMinor = sum(summaries.map((summary) => summary.totalCostMinor));
  const withPnl = summaries.filter((summary) => summary.pnlMinor !== null);
  const pnlMinor = withPnl.length === 0 ? null : sum(withPnl.map((summary) => summary.pnlMinor!));
  const withDay = summaries.filter((summary) => summary.dayChangeMinor !== null);
  const dayChangeMinor = withDay.length === 0 ? null : sum(withDay.map((summary) => summary.dayChangeMinor!));
  const previousMinor = sum(withDay.map((summary) => summary.totalValueMinor - summary.dayChangeMinor!));
  const unpricedSymbols = union(summaries.map((summary) => summary.unpricedSymbols));
  return {
    baseCurrency,
    totalValueMinor,
    totalCostMinor,
    pnlMinor,
    pnlPct: pnlMinor !== null && totalCostMinor > 0 ? percent(pnlMinor, totalCostMinor) : null,
    dayChangeMinor,
    dayChangePct: dayChangeMinor !== null && previousMinor > 0 ? percent(dayChangeMinor, previousMinor) : null,
    holdingsCount: sum(summaries.map((summary) => summary.holdingsCount)),
    pricedCount: sum(summaries.map((summary) => summary.pricedCount)),
    unpricedSymbols,
    uncostedSymbols: union(summaries.map((summary) => summary.uncostedSymbols)),
    degraded: summaries.some((summary) => summary.degraded),
    asOf,
  };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function union(lists: string[][]): string[] {
  return [...new Set(lists.flat())].sort();
}

/** A ratio as a percentage at four decimals, the precision every summary carries. */
function percent(part: number, whole: number): number {
  return Math.round((part / whole) * 100 * 10_000) / 10_000;
}
