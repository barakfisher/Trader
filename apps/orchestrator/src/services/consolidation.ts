/**
 * The consolidated holdings view (multi-agent Stage 3, PR 6; spec §4.3, D17,
 * D18, D32-D35): one row per instrument across the real portfolio and every
 * non-archived simulated agent, each row carrying the per-agent split.
 *
 * The one rule that shapes everything here: **real and simulated are never
 * summed into one figure.** A row says "40 real" and "5 simulated" side by
 * side; the headline says "real $48,000" and "simulated $15,000" side by side.
 * A blended number that mixed twelve real shares with two imaginary ones would
 * tell the user something false, and nothing on the screen could show it.
 *
 * Each agent is valued exactly as its own page values it (`valueAgentAccount`),
 * and the real portfolio exactly as `/portfolio` does, so the dashboard and the
 * agent page cannot disagree about a figure. Quotes are cached by the AI
 * service, so valuing agent by agent costs no extra provider requests.
 *
 * Agents are USD-only (D7) and so is the base currency (guideline 10): every
 * figure here is in one currency, and the response names it.
 */

import type {
  AgentAccountResponse,
  ConsolidatedHoldingsResponse,
  ConsolidatedPosition,
  ConsolidatedRow,
  ConsolidatedSide,
  HoldingView,
  PortfolioResponse,
  SimulatedAgentStanding,
  SimulatedTotals,
} from '@traders/shared';

import type { AgentRow } from '../db/queries.js';

/** `numeric(38, 18)`: the scale every stored quantity has. */
const QUANTITY_SCALE = 18;
const QUANTITY_UNIT = 10n ** BigInt(QUANTITY_SCALE);

function scaledQuantity(text: string): bigint {
  const [whole = '0', fraction = ''] = text.trim().split('.');
  return BigInt(whole) * QUANTITY_UNIT + BigInt(fraction.padEnd(QUANTITY_SCALE, '0').slice(0, QUANTITY_SCALE));
}

/**
 * Exact sum of decimal-string quantities (guideline 4), in the shape Postgres
 * returns them. Never through a float: 0.1 + 0.2 shares is 0.3 shares.
 */
export function addQuantities(quantities: string[]): string {
  const total = quantities.reduce((sum, quantity) => sum + scaledQuantity(quantity), 0n);
  const whole = total / QUANTITY_UNIT;
  const fraction = (total % QUANTITY_UNIT).toString().padStart(QUANTITY_SCALE, '0');
  return `${whole}.${fraction}`;
}

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
  };
}

export function simulatedTotals(standings: SimulatedAgentStanding[]): SimulatedTotals {
  return {
    agentCount: standings.length,
    cashMinor: standings.reduce((sum, standing) => sum + standing.cashMinor, 0),
    holdingsValueMinor: sumKnown(standings.map((standing) => standing.holdingsValueMinor)),
    netWorthMinor: sumKnown(standings.map((standing) => standing.netWorthMinor)),
    unpricedSymbols: [...new Set(standings.flatMap((standing) => standing.unpricedSymbols))].sort(),
  };
}

export interface ValuedAgent {
  agent: AgentRow;
  account: AgentAccountResponse;
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
    simulated: simulatedTotals(standings),
    agents: standings,
    rows,
  };
}
