/**
 * Approving a trade proposal: a preview at the live price, then a confirm that
 * fills (Stage 4, PR 5a; D47-D49).
 *
 * - **Approve is a preview (D47).** The proposal carries the agent's price - at
 *   a pre-open scan, the previous close. The preview prices the trade at the
 *   live quote exactly as a manual trade's does (`previewTrade`: exchange open,
 *   quote fresh, cash and fee), beside the agent's price and the distance
 *   between them, and is **refused beyond `MAX_AGENT_DISTANCE_BPS`**: the thesis
 *   was formed at a price that no longer holds.
 * - **Confirm fills through `executeFill`** within D3's ±50 bps of the price the
 *   preview showed, and the approval is written in the fill's own transaction
 *   (D11), so an approval without its fill, or a fill without its approval,
 *   cannot be committed. The fill is `source = 'agent'` with its proposal - the
 *   only way such a fill can exist (0044).
 * - **A refusal leaves the proposal pending (D49)** and is recorded in
 *   `proposal_attempts` with both prices; the user may try again until it
 *   expires, or reject it.
 * - **Approve and Reject only (D48).** Snooze and undo are refused for trade
 *   kinds in `applyDecision`, whatever a surface sends; reject goes through it
 *   unchanged.
 *
 * The idempotency key is the proposal's: a confirm repeated after a lost reply
 * meets the fill the first one wrote, and answers it.
 */

import {
  isTradeProposalKind,
  type TradeApprovalPreview,
  type TradeApprovalResult,
  type TradeProposalKind,
  type TradeProposalPayload,
} from '@traders/shared';

import {
  applyProposalTransitionIn,
  findFillByKey,
  findProposal,
  getAgent,
  getAgentCash,
  getAgentHoldingQuantity,
  recordProposalAttempt,
  type AgentRow,
  type ProposalRow,
} from '../db/queries.js';
import { ApiProblem, conflict, notFound, unprocessable } from '../http/errors.js';
import { logger } from '../logger.js';
import {
  deviationBps,
  executeFill,
  previewTrade,
  toFillView,
  type TradeContext,
  type TradeRequest,
} from './fills.js';
import { factsOf } from './proposals.js';
import { effectiveState } from './proposalState.js';

/** D47: a live price further than this from the agent's refuses the preview. */
export const MAX_AGENT_DISTANCE_BPS = 300n;

export type ApprovalSurface = 'web' | 'telegram';

interface OpenTrade {
  row: ProposalRow;
  kind: TradeProposalKind;
  payload: TradeProposalPayload;
  agent: AgentRow;
}

/** The fill's idempotency key: one per proposal, so a repeated confirm is one fill. */
export function approvalKey(proposalId: string): string {
  return `proposal:${proposalId}`;
}

async function loadTrade(userId: string, proposalId: string): Promise<OpenTrade> {
  const row = await findProposal(userId, proposalId);
  if (row === null) throw notFound('proposal not found');
  if (!isTradeProposalKind(row.kind)) {
    throw unprocessable('not_a_trade', 'only a buy or sell proposal is approved at a price');
  }
  const agent = await getAgent(userId, row.agent_id);
  if (agent === null) throw notFound('proposal not found');
  return { row, kind: row.kind, payload: row.payload as TradeProposalPayload, agent };
}

function assertOpen(trade: OpenTrade, now: Date): void {
  const state = effectiveState(factsOf(trade.row), now);
  if (state === 'expired') {
    throw unprocessable('expired', 'this proposal has expired and can no longer be decided', { state });
  }
  if (state !== 'pending') {
    throw unprocessable('already_decided', 'this proposal has already been decided', { state });
  }
}

function tradeRequest(userId: string, trade: OpenTrade, shownPriceMinor: bigint | null): TradeRequest {
  return {
    userId,
    agent: trade.agent,
    symbol: trade.payload.symbol,
    side: trade.kind,
    quantity: trade.payload.quantity,
    price: { source: 'quote', shownPriceMinor },
    source: 'agent',
    proposalId: trade.row.id,
    idempotencyKey: approvalKey(trade.row.id),
  };
}

/** The live price a refusal reports, when it had one. */
function livePriceOf(details: unknown): bigint | null {
  const live = (details as { livePriceMinor?: unknown } | undefined)?.livePriceMinor;
  return typeof live === 'number' && Number.isSafeInteger(live) && live > 0 ? BigInt(live) : null;
}

/**
 * Run `attempt`; a refusal of the trade itself is recorded (D49) and re-thrown.
 * Refusals about the proposal - not found, already decided, expired - are not
 * attempts at a price, and are not recorded.
 */
async function recordingRefusals<T>(
  userId: string,
  trade: OpenTrade,
  surface: ApprovalSurface,
  attempt: () => Promise<T>,
): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    if (
      error instanceof ApiProblem &&
      (error.status === 409 || error.status === 422) &&
      error.code !== 'already_decided'
    ) {
      const details = error.details as { quoteAsOf?: unknown } | undefined;
      await recordProposalAttempt({
        userId,
        proposalId: trade.row.id,
        surface,
        reason: error.code,
        agentPriceMinor: BigInt(trade.payload.priceMinor),
        livePriceMinor: livePriceOf(error.details),
        quoteAsOf: typeof details?.quoteAsOf === 'string' ? details.quoteAsOf : null,
      });
      logger().info({ proposalId: trade.row.id, surface, reason: error.code }, 'proposal.approval_refused');
    }
    throw error;
  }
}

/** *Approve*: the trade at the live price beside the agent's, or why not. Writes no ledger row. */
export async function previewTradeApproval(
  userId: string,
  proposalId: string,
  surface: ApprovalSurface,
  context: TradeContext,
): Promise<TradeApprovalPreview> {
  const trade = await loadTrade(userId, proposalId);
  assertOpen(trade, (context.now ?? (() => new Date()))());
  return recordingRefusals(userId, trade, surface, async () => {
    const preview = await previewTrade(tradeRequest(userId, trade, null), context);
    const agentPrice = BigInt(trade.payload.priceMinor);
    const live = BigInt(preview.priceMinor);
    const distance = deviationBps(live, agentPrice);
    if ((distance < 0n ? -distance : distance) > MAX_AGENT_DISTANCE_BPS) {
      throw unprocessable(
        'price_far_from_agent',
        'the price has moved more than 3% from the one the agent decided at: reject it, or try again later',
        {
          agentPriceMinor: trade.payload.priceMinor,
          livePriceMinor: preview.priceMinor,
          distanceBps: Number(distance),
          quoteAsOf: preview.quoteAsOf,
        },
      );
    }
    return {
      proposalId: trade.row.id,
      agentPriceMinor: trade.payload.priceMinor,
      distanceBps: Number(distance),
      maxDistanceBps: Number(MAX_AGENT_DISTANCE_BPS),
      trade: preview,
    };
  });
}

/** A confirm repeated after the first one filled: the fill it wrote, and the state now. */
async function replayApproval(userId: string, trade: OpenTrade): Promise<TradeApprovalResult | null> {
  const fill = await findFillByKey(userId, trade.agent.id, approvalKey(trade.row.id));
  if (!fill) return null;
  const cash = await getAgentCash(userId, trade.agent.id);
  const held = await getAgentHoldingQuantity(userId, trade.agent.id, fill.instrument_id);
  return {
    state: 'approved',
    fill: toFillView(fill),
    cashMinor: Number(cash?.balance_minor ?? '0'),
    heldQuantity: (held ?? '0').split('.')[0]!,
  };
}

/**
 * *Confirm*: fill within ±50 bps of the price the preview showed, and approve,
 * in one transaction - or refuse, record it and leave the proposal pending.
 */
export async function confirmTradeApproval(
  userId: string,
  proposalId: string,
  shownPriceMinor: bigint,
  surface: ApprovalSurface,
  context: TradeContext,
): Promise<TradeApprovalResult> {
  const trade = await loadTrade(userId, proposalId);
  if (trade.row.state === 'approved') {
    const replayed = await replayApproval(userId, trade);
    if (replayed) return replayed;
  }
  assertOpen(trade, (context.now ?? (() => new Date()))());

  const result = await recordingRefusals(userId, trade, surface, () =>
    executeFill(tradeRequest(userId, trade, shownPriceMinor), context, async (client) => {
      const transition = await applyProposalTransitionIn(client, {
        proposalId: trade.row.id,
        userId,
        fromState: trade.row.state,
        toState: 'approved',
        surface,
        actorUserId: userId,
        snoozedUntil: null,
        evidenceSnapshot: trade.row.evidence,
        idempotencyKey: null,
        // The fill is the ledger row; an intent would record the same assent twice.
        intent: null,
        revokeIntent: false,
      });
      // Another surface decided it between the read and this write: roll the fill back.
      if (!transition.applied) throw conflict('already_decided', 'this proposal has already been decided');
    }),
  );
  logger().info(
    { proposalId: trade.row.id, surface, fillId: result.fill.id, created: result.created },
    'proposal.trade_approved',
  );
  return { state: 'approved', fill: result.fill, cashMinor: result.cashMinor, heldQuantity: result.heldQuantity };
}
