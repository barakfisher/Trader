/**
 * A simulated agent's account as the agent page shows it (Stage 3, PR 5).
 *
 * Net worth is cash plus the market value of what the agent holds; P&L is net
 * worth minus every deposit - the budget, which is the sum of the opening
 * deposit and the top-ups (D6, D22). Fees already left cash, so they are never
 * subtracted again. When any holding is unpriced, net worth and P&L are null:
 * a figure that silently left a position out would read as complete
 * (guideline 7), and the holdings list names what is unpriced.
 */

import type { AgentAccountResponse } from '@traders/shared';

import type { AgentRow, HoldingRow } from '../db/queries.js';
import { valuePortfolio, type ValuationContext } from './valuation.js';

export async function valueAgentAccount(
  agent: AgentRow,
  rows: HoldingRow[],
  context: ValuationContext,
): Promise<AgentAccountResponse> {
  const cash = Number(agent.cash_minor ?? 0);
  const deposits = Number(agent.budget_minor ?? 0);
  const portfolio = await valuePortfolio(rows, context);
  const complete = portfolio.summary.unpricedSymbols.length === 0;
  const holdingsValue = complete ? portfolio.summary.totalValueMinor : null;
  const netWorth = holdingsValue === null ? null : cash + holdingsValue;
  const pnl = netWorth === null ? null : netWorth - deposits;
  return {
    currency: agent.currency,
    cashMinor: cash,
    depositsMinor: deposits,
    holdingsValueMinor: holdingsValue,
    netWorthMinor: netWorth,
    pnlMinor: pnl,
    pnlPct: pnl === null || deposits === 0 ? null : (pnl / deposits) * 100,
    portfolio,
  };
}
