/**
 * A stored scan as the *Decisions* tab lists it (D50): its trades with each
 * proposal's state now, read from the answer as stored before and after D197.
 * Shared by the agent page's routes and the Telegram last-run view (M11), so
 * the two never read one scan two ways.
 */

import type { AgentScanSummary, AgentScanOutcome, AgentScanTrade } from '@traders/shared';

import type { AgentScanRow } from '../db/queries.js';
import { effectiveState } from './proposalState.js';

const sideOf = (value: unknown): AgentScanTrade['decision'] => (value === 'buy' || value === 'sell' ? value : null);

export const textOf = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const textsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/**
 * The trades an answer wrote, as stored: the list since D197, or the one trade
 * every answer was before it (`{decision, symbol, quantity}`; `none` is no trade).
 */
function writtenTrades(answer: Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray(answer.trades)) {
    return answer.trades.filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null);
  }
  return answer.decision === 'buy' || answer.decision === 'sell' ? [answer] : [];
}

/**
 * The answer's own reason: a pass's why, or an overview beside its trades. In a
 * one-trade answer from before D197 the thesis is that trade's, already shown
 * under it (`writtenTrades`), so it is not the answer's too.
 */
export function answerThesis(answer: Record<string, unknown>): string | null {
  return writtenTrades(answer).includes(answer) ? null : textOf(answer.thesis);
}

export function toScanSummary(row: AgentScanRow, now: Date): AgentScanSummary {
  const answer = row.answer ?? {};
  // Each trade's proposal is the scan's proposal for its symbol (one per symbol, 0061).
  const bySymbol = new Map(row.proposals.map((proposal) => [proposal.symbol, proposal]));
  const trades = writtenTrades(answer).map((written): AgentScanTrade => {
    const symbol = textOf(written.symbol);
    const current = Array.isArray(answer.trades);
    // Before D197 an answer's one trade was proposed exactly when the scan was a `trade`.
    const refused = current ? written.refused === true : row.outcome !== 'trade';
    const proposal = refused || symbol === null ? undefined : bySymbol.get(symbol.toUpperCase());
    return {
      decision: sideOf(written.decision),
      symbol,
      quantity: textOf(written.quantity),
      thesis: textOf(written.thesis),
      fundedBy: textsOf(written.funded_by),
      refused,
      // Before D197 a refused answer's reasons were the answer's own, and so its one trade's.
      problems: textsOf(written.problems),
      // The state now, not as stored: a proposal past its deadline reads expired
      // before the sweep catches up, as everywhere else.
      proposal: proposal
        ? {
            id: proposal.id,
            state: effectiveState(
              {
                state: proposal.state as never,
                expiresAt: new Date(proposal.expires_at),
                snoozedUntil: proposal.snoozed_until === null ? null : new Date(proposal.snoozed_until),
                decidedAt: proposal.decided_at === null ? null : new Date(proposal.decided_at),
              },
              now,
            ),
          }
        : null,
      fillId: proposal?.fill_id ?? null,
    };
  });
  return {
    id: row.id,
    trigger: row.trigger === 'schedule' || row.trigger === 'refresh' ? row.trigger : 'manual',
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
    outcome: row.outcome as AgentScanOutcome | null,
    steps: row.steps,
    costMicroUsd: Number(row.cost_micro_usd),
    model: row.model,
    trades,
    problems: textsOf(answer.problems),
    cashUnjustified: answer.cash_unjustified === true,
    error: row.error,
  };
}
