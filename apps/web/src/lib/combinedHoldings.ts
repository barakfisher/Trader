/**
 * The dashboard's one holdings table and its four cards, for any scope (D229,
 * D231): the consolidated response cut down to the positions the scope shows,
 * one row per instrument, each row carrying who holds it and the agents'
 * pending trades on it.
 *
 * A row adds its positions together - real and simulated under *All* - and
 * keeps every position, so the table can always say whose each part is. The
 * rules are the summary's (D230): cost and P&L cover only positions with both a
 * price and a cost basis, and a position without a cost basis is flagged, never
 * read at zero cost.
 */

import {
  addQuantities,
  combineSummaries,
  type ConsolidatedHoldingsResponse,
  type ConsolidatedPendingTrade,
  type ConsolidatedPosition,
  type ConsolidatedRow,
  type PortfolioSummary,
} from '@traders/shared';

import { inScope, type HoldingsScope } from './holdingsScope.ts';

export interface CombinedHolding {
  instrument: ConsolidatedRow['instrument'];
  quote: ConsolidatedRow['quote'];
  /** The scope's positions, the real portfolio's first. Never empty. */
  positions: ConsolidatedPosition[];
  quantity: string;
  /** Null when the instrument is unpriced: a value is never invented (guideline 7). */
  valueMinor: number | null;
  /** What was paid, over the positions that have a cost basis; null when none has. */
  costMinor: number | null;
  /** Over the positions with a price and a cost basis; null when there are none. */
  pnlMinor: number | null;
  pnlPct: number | null;
  /** Some position in the row has no cost basis: its P&L is left out, and the row says so. */
  uncosted: boolean;
  weightPct: number | null;
  /** The scope's agents' pending trades on this ticker. */
  pending: ConsolidatedPendingTrade[];
}

export interface CombinedHoldings {
  rows: CombinedHolding[];
  /** Pending trades on tickers no position in the scope holds - a buy of something new. */
  unheldPending: ConsolidatedPendingTrade[];
}

/** One source of a combined figure: the real portfolio or one agent. */
export interface SummarySource {
  key: string;
  isPrimary: boolean;
  /** The stored name; the primary is named from the catalogue by the caller. */
  name: string;
  summary: PortfolioSummary;
  /** An agent's uninvested paper cash; the real portfolio has none on record. */
  cashMinor: number | null;
}

function sumOrNull(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((total, value) => total + value, 0);
}

function percent(part: number, whole: number): number {
  return Math.round((part / whole) * 100 * 10_000) / 10_000;
}

export function combinedHoldings(data: ConsolidatedHoldingsResponse, scope: HoldingsScope): CombinedHoldings {
  const pending = data.pendingTrades.filter((trade) => inScope(scope, { agentId: trade.agentId, isPrimary: false }));
  const rows = data.rows
    .map((row) => ({ row, positions: row.positions.filter((position) => inScope(scope, position)) }))
    .filter(({ positions }) => positions.length > 0);
  const valueOf = (positions: ConsolidatedPosition[]) =>
    positions.some((position) => position.valueMinor === null)
      ? null
      : positions.reduce((total, position) => total + position.valueMinor!, 0);
  const totalMinor = rows.reduce((total, { positions }) => total + (valueOf(positions) ?? 0), 0);

  const combined = rows.map(({ row, positions }): CombinedHolding => {
    const valueMinor = valueOf(positions);
    const measured = positions.filter((position) => position.valueMinor !== null && position.costMinor !== null);
    const measuredCost = sumOrNull(measured.map((position) => position.costMinor!));
    const pnlMinor = sumOrNull(measured.map((position) => position.valueMinor! - position.costMinor!));
    return {
      instrument: row.instrument,
      quote: row.quote,
      positions,
      quantity: addQuantities(positions.map((position) => position.quantity)),
      valueMinor,
      costMinor: sumOrNull(
        positions.filter((position) => position.costMinor !== null).map((position) => position.costMinor!),
      ),
      pnlMinor,
      pnlPct: pnlMinor !== null && measuredCost !== null && measuredCost > 0 ? percent(pnlMinor, measuredCost) : null,
      uncosted: positions.some((position) => position.costBasisMinor === null),
      weightPct: valueMinor !== null && totalMinor > 0 ? percent(valueMinor, totalMinor) : null,
      pending: pending.filter((trade) => trade.symbol === row.instrument.symbol),
    };
  });
  const held = new Set(combined.map((row) => row.instrument.symbol));
  return { rows: combined, unheldPending: pending.filter((trade) => !held.has(trade.symbol)) };
}

/** Every source a scope's cards add up: the real portfolio and each agent it shows. */
export function summarySources(data: ConsolidatedHoldingsResponse, scope: HoldingsScope): SummarySource[] {
  const real: SummarySource = {
    key: 'real',
    isPrimary: true,
    name: '',
    summary: data.real,
    cashMinor: null,
  };
  const agents = data.agents
    .filter((standing) => inScope(scope, { agentId: standing.agentId, isPrimary: false }))
    .map(
      (standing): SummarySource => ({
        key: standing.agentId,
        isPrimary: false,
        name: standing.name,
        summary: standing.summary,
        cashMinor: standing.cashMinor,
      }),
    );
  if (scope.kind === 'real') return [real];
  if (scope.kind === 'all') return [real, ...agents];
  return agents;
}

/** The figures a scope's four cards show: its sources added together. */
export function scopeSummary(data: ConsolidatedHoldingsResponse, sources: SummarySource[]): PortfolioSummary {
  return sources.length === 1
    ? sources[0]!.summary
    : combineSummaries(
        data.currency,
        sources.map((source) => source.summary),
        data.real.asOf,
      );
}
