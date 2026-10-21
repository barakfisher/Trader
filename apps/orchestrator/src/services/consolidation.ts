/**
 * The consolidated holdings view (multi-agent Stage 3, PR 6; spec §4.3, D17,
 * D18, D32-D35): one row per instrument across the real portfolio and every
 * non-archived simulated agent, each row carrying the per-agent split.
 *
 * Each row keeps the real and the simulated sides apart, and every position
 * says whose it is. The headline cards add the real portfolio and the agents'
 * holdings together under *All* (D231, superseding D34's "never summed"); a
 * combined figure never stands alone - the dashboard opens its split by source
 * from the card, and a row's split from its quantity and value.
 *
 * Each agent is valued exactly as its own page values it (`valueAgentAccount`),
 * and the real portfolio exactly as `/portfolio` does, so the dashboard and the
 * agent page cannot disagree about a figure. Quotes are cached by the AI
 * service, so valuing agent by agent costs no extra provider requests.
 *
 * Agents are USD-only (D7) and so is the base currency (guideline 10): every
 * figure here is in one currency, and the response names it.
 */

import {
  addQuantities,
  combineSummaries,
  isTradeProposalKind,
  type TradeProposalPayload,
} from '@traders/shared';
import type {
  AgentAccountResponse,
  ConsolidatedHoldingsResponse,
  ConsolidatedPendingTrade,
  ConsolidatedPosition,
  ConsolidatedRow,
  ConsolidatedSide,
  HoldingView,
  PortfolioResponse,
  SimulatedAgentStanding,
  SimulatedTotals,
} from '@traders/shared';

import type { AgentRow, ProposalRow } from '../db/queries.js';
import { factsOf } from './proposals.js';
import { effectiveState } from './proposalState.js';

export { addQuantities };

/** Sum of values that are all known, or null: a total that skipped one would read as complete. */
function sumKnown(values: (number | null)[]): number | null {
  return values.some((value) => value === null) ? null : values.reduce<number>((sum, value) => sum + value!, 0);
}

function side(positions: ConsolidatedPosition[]): ConsolidatedSide | null {
  if (positions.length === 0) return null;
  return {
    quantity: addQuantities(positions.map((position) => position.quantity)),
    valueMinor: sumKnown(positions.map((position) => position.valueMinor)),
  };
}

function position(agent: AgentRow, holding: HoldingView): ConsolidatedPosition {
  return {
    agentId: agent.id,
    agentName: agent.name,
    isPrimary: agent.is_primary,
    state: agent.state,
    holdingId: holding.id,
    quantity: holding.quantity,
    costBasisMinor: holding.costBasisMinor,
    costCurrency: holding.costCurrency,
    valueMinor: holding.valueMinor,
    costMinor: holding.costMinor,
    pnlMinor: holding.pnlMinor,
    pnlPct: holding.pnlPct,
  };
}

export function standingOf(agent: AgentRow, account: AgentAccountResponse): SimulatedAgentStanding {
  return {
    agentId: agent.id,
    name: agent.name,
    state: agent.state,
    currency: account.currency,
    cashMinor: account.cashMinor,
    depositsMinor: account.depositsMinor,
    holdingsValueMinor: account.holdingsValueMinor,
    netWorthMinor: account.netWorthMinor,
    pnlMinor: account.pnlMinor,
    pnlPct: account.pnlPct,
    unpricedSymbols: account.portfolio.summary.unpricedSymbols,
    summary: account.portfolio.summary,
  };
}

export function simulatedTotals(
  standings: SimulatedAgentStanding[],
  currency: string,
  asOf: string,
): SimulatedTotals {
  return {
    agentCount: standings.length,
    cashMinor: standings.reduce((sum, standing) => sum + standing.cashMinor, 0),
    holdingsValueMinor: sumKnown(standings.map((standing) => standing.holdingsValueMinor)),
    netWorthMinor: sumKnown(standings.map((standing) => standing.netWorthMinor)),
    unpricedSymbols: [...new Set(standings.flatMap((standing) => standing.unpricedSymbols))].sort(),
    summary: combineSummaries(
      currency,
      standings.map((standing) => standing.summary),
      asOf,
    ),
  };
}

export interface ValuedAgent {
  agent: AgentRow;
  account: AgentAccountResponse;
}

/**
 * The trade proposals still answerable now, of the agents the view shows
 * (D35, D63): pending by its deadline, not only by its stored state, and never
 * an archived agent's.
 */
export function pendingTradesOf(
  proposals: ProposalRow[],
  agents: AgentRow[],
  now: Date,
): ConsolidatedPendingTrade[] {
  const shown = new Set(agents.map((agent) => agent.id));
  return proposals
    .filter(
      (row) =>
        isTradeProposalKind(row.kind) &&
        shown.has(row.agent_id) &&
        effectiveState(factsOf(row), now) === 'pending',
    )
    .map((row) => {
      const payload = row.payload as TradeProposalPayload;
      return {
        proposalId: row.id,
        agentId: row.agent_id,
        agentName: row.agent_name,
        side: row.kind as 'buy' | 'sell',
        symbol: payload.symbol,
        quantity: payload.quantity,
        agentPriceMinor: payload.priceMinor,
        currency: payload.currency,
        expiresAt: row.expires_at.toISOString(),
      };
    })
    .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
}

/**
 * The view, from valuations already made. `simulated` must already exclude
 * archived agents (D18) and be in the order the agents list shows them.
 */
export function consolidate(
  currency: string,
  primary: AgentRow,
  real: PortfolioResponse,
  simulated: ValuedAgent[],
  pendingTrades: ConsolidatedPendingTrade[] = [],
): ConsolidatedHoldingsResponse {
  const byInstrument = new Map<string, { holdings: HoldingView[]; positions: ConsolidatedPosition[] }>();
  const add = (agent: AgentRow, holding: HoldingView) => {
    const entry = byInstrument.get(holding.instrument.id) ?? { holdings: [], positions: [] };
    entry.holdings.push(holding);
    entry.positions.push(position(agent, holding));
    byInstrument.set(holding.instrument.id, entry);
  };
  real.holdings.forEach((holding) => add(primary, holding));
  simulated.forEach(({ agent, account }) => account.portfolio.holdings.forEach((holding) => add(agent, holding)));

  const rows: ConsolidatedRow[] = [...byInstrument.values()]
    .map(({ holdings, positions }) => ({
      instrument: holdings[0]!.instrument,
      // One instrument, one quote; the first holding that was priced carries it.
      quote: holdings.find((holding) => holding.quote !== null)?.quote ?? null,
      real: side(positions.filter((entry) => entry.isPrimary)),
      simulated: side(positions.filter((entry) => !entry.isPrimary)),
      positions,
    }))
    .sort((a, b) => a.instrument.symbol.localeCompare(b.instrument.symbol));

  const standings = simulated.map(({ agent, account }) => standingOf(agent, account));
  return {
    currency,
    real: real.summary,
    simulated: simulatedTotals(standings, currency, real.summary.asOf),
    agents: standings,
    rows,
    pendingTrades,
  };
}
