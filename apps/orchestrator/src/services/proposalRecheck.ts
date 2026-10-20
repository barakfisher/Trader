/**
 * Re-checking an expired trade proposal (improvements item 4; D212-D217).
 *
 * A trade proposal lives an hour from the next open (D4). One the user did not
 * answer in time can be re-checked once, from the web or Telegram: the AI
 * service runs a `refresh` scan of that one trade (`app/agents/recheck.py`),
 * and a kept trade becomes a new proposal here exactly as a scan's does
 * (`proposeFromScan`: written, announced with Approve and Reject). The AI
 * service owns the re-check and "once" (`agent_scans_one_refresh`); this
 * module owns what the user is told:
 *
 * - **proposed** - the new proposal's id;
 * - **declined** - the agent's own reason, validated like a thesis and written
 *   in the user's language (D51), or the server check that refused the trade,
 *   by code, for the catalogues to say (D214);
 * - **unanswered** - it ended without an answer (failed, a budget, the cap, the
 *   user's own key); the refresh is not used up and may be tried again (D213);
 * - **running** - started and not finished.
 *
 * Whether *Re-check* is offered (D215) is computed here from the same rows, so
 * the page, the Telegram keyboard and the AI service's refusal agree: a buy or
 * sell that expired unanswered, at most `RECHECK_WINDOW_DAYS` ago, whose agent
 * is active, with no re-check that counts.
 */

import {
  isTradeProposalKind,
  RECHECK_CHECKS,
  RECHECK_UNANSWERED,
  RECHECK_WINDOW_DAYS,
  type ProposalRecheck,
  type RecheckCheck,
  type RecheckResult,
  type RecheckUnanswered,
} from '@traders/shared';
import { AiServiceError, type AgentScanResponse, type AiClient } from '@traders/shared/ai';

import { findProposal, getAgent, latestRecheck, type ProposalRow, type RecheckRow } from '../db/queries.js';
import { aiRefusal, conflict, notFound, upstreamFailure } from '../http/errors.js';
import { logger } from '../logger.js';
import type { Notifier } from '../notify/notifier.js';
import { factsOf } from './proposals.js';
import { effectiveState } from './proposalState.js';
import { proposeFromScan } from './tradeProposals.js';

export const RECHECK_WINDOW_MS = RECHECK_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** `scan_log.ABANDONED_AFTER`: a re-check still unfinished after this never will be. */
export const RECHECK_ABANDONED_AFTER_MS = 15 * 60 * 1000;

export interface RecheckContext {
  ai: AiClient;
  notifier: Notifier;
  requestId?: string;
  now?: () => Date;
}

const UNANSWERED = new Set<string>(RECHECK_UNANSWERED);
const CHECKS = new Set<string>(RECHECK_CHECKS);

/** What a re-check's stored scan came to; `newProposalId` is the proposal it raised. */
export function recheckResultOf(row: RecheckRow, now: Date): RecheckResult {
  const base = { scanId: row.scan_id, at: row.started_at.toISOString() };
  if (row.outcome === null) {
    // The AI service closes an abandoned scan as `failed` at the agent's next scan.
    return now.getTime() - row.started_at.getTime() > RECHECK_ABANDONED_AFTER_MS
      ? { ...base, outcome: 'unanswered', cause: 'failed' }
      : { ...base, outcome: 'running' };
  }
  if (UNANSWERED.has(row.outcome)) {
    return { ...base, outcome: 'unanswered', cause: row.outcome as RecheckUnanswered };
  }
  if (row.new_proposal_id !== null) return { ...base, outcome: 'proposed', proposalId: row.new_proposal_id };

  const answer = row.answer ?? {};
  const trades = Array.isArray(answer.trades) ? (answer.trades as Record<string, unknown>[]) : [];
  const refused = trades.find((trade) => trade.refused === true);
  if (refused !== undefined) {
    const code = typeof refused.code === 'string' && CHECKS.has(refused.code) ? refused.code : 'no_answer';
    return { ...base, outcome: 'declined', reason: { kind: 'check', check: code as RecheckCheck } };
  }
  // A pass's reason reached here only through the evidence validator (scan.py).
  if (row.outcome === 'no_trade' && typeof answer.thesis === 'string' && answer.thesis.trim() !== '') {
    return { ...base, outcome: 'declined', reason: { kind: 'agent', thesis: answer.thesis } };
  }
  return { ...base, outcome: 'declined', reason: { kind: 'check', check: 'no_answer' } };
}

/** Why *Re-check* is not offered, in the AI service's refusal codes; null when it is. */
export type RecheckBlock = 'not_expired' | 'recheck_window_passed' | 'already_rechecked' | 'agent_not_active' | 'scan_running';

/**
 * A trade proposal's re-check - whether it is offered now, and the last one - and
 * why not when it is not. Null for every other kind.
 */
export async function recheckStatus(
  userId: string,
  row: ProposalRow,
  now: Date,
): Promise<{ recheck: ProposalRecheck; blocked: RecheckBlock | null } | null> {
  if (!isTradeProposalKind(row.kind)) return null;
  const [stored, agent] = await Promise.all([
    latestRecheck(userId, row.agent_id, row.id),
    getAgent(userId, row.agent_id),
  ]);
  const last = stored === null ? null : recheckResultOf(stored, now);
  const blocked: RecheckBlock | null =
    // Expired is unanswered: an approval or a rejection is terminal and stays itself.
    effectiveState(factsOf(row), now) !== 'expired'
      ? 'not_expired'
      : now.getTime() - row.expires_at.getTime() > RECHECK_WINDOW_MS
        ? 'recheck_window_passed'
        : last?.outcome === 'running'
          ? 'scan_running'
          : last !== null && last.outcome !== 'unanswered'
            ? 'already_rechecked'
            : agent === null || agent.state !== 'active' || agent.is_primary
              ? 'agent_not_active'
              : null;
  return { recheck: { available: blocked === null, last }, blocked };
}

/** The proposal page's view of it (`ProposalDetailResponse.recheck`). */
export async function recheckOf(userId: string, row: ProposalRow, now: Date): Promise<ProposalRecheck | null> {
  return (await recheckStatus(userId, row, now))?.recheck ?? null;
}

/**
 * Re-check one expired trade proposal now. Refusals are the AI service's,
 * passed on with their codes (`not_expired`, `already_rechecked`,
 * `budget_spent`, `scan_running`, …); everything else is the result.
 */
export async function recheckProposal(
  userId: string,
  proposalId: string,
  context: RecheckContext,
): Promise<RecheckResult> {
  const row = await findProposal(userId, proposalId);
  if (row === null) throw notFound('proposal not found');
  if (!isTradeProposalKind(row.kind)) throw conflict('not_a_trade', 'only a trade proposal is re-checked');
  const agent = await getAgent(userId, row.agent_id);
  if (agent === null) throw notFound('agent not found');

  let scan: AgentScanResponse;
  try {
    scan = await context.ai.recheckProposal(agent.id, proposalId, { user_id: userId }, context.requestId);
  } catch (error) {
    if (error instanceof AiServiceError) {
      const reason = aiRefusal(error.body);
      if (error.status === 404) throw notFound('proposal not found');
      if (error.status === 409 && reason) throw conflict(reason.code, reason.message);
      if (error.status === 503 && reason?.code === 'no_model') {
        throw upstreamFailure(503, 'No model is configured for scans. Choose one on the Admin page.');
      }
      throw upstreamFailure(error.status, 'The re-check could not run.');
    }
    throw error;
  }

  const now = (context.now ?? (() => new Date()))();
  const [newProposalId] = await proposeFromScan(userId, agent, scan, {
    ai: context.ai,
    notifier: context.notifier,
    ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
    now: () => now,
  });
  const result = recheckResultOf(
    {
      scan_id: scan.scan_id,
      started_at: now,
      finished_at: now,
      outcome: scan.outcome,
      answer: (scan.answer ?? null) as Record<string, unknown> | null,
      new_proposal_id: newProposalId ?? null,
    },
    now,
  );
  logger().info({ proposalId, scanId: scan.scan_id, outcome: result.outcome }, 'proposal.rechecked');
  return result;
}
