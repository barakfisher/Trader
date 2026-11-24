/**
 * Approving a trade for the open (D398-D401).
 *
 * Every trade proposal measured on production (2026-11-09 to 11-18) was raised
 * while the market was closed, so Approve - a preview at the live price (D47) -
 * was refused `market_closed` until the open. The user approves it for the open
 * instead, and the minute tick fills it once the market opens:
 *
 * - **The same checks as Approve (D398).** The open runs `previewTradeApproval`
 *   and then `confirmTradeApproval` at the price that preview showed: the live
 *   price within 3% of the agent's, cash and holdings, the mandate's warnings
 *   (which warn, never block). A refusal is recorded as Approve's is (D49).
 * - **Only a passing moment is retried (D399).** A closed market (the calendar
 *   a few seconds behind the open), a stale or missing quote, or an AI service
 *   that did not answer leaves the approval waiting for the next minute's tick.
 *   Anything about the trade itself - the price too far, the cash short - ends
 *   it: the user is told why, and the proposal stays open to approve by hand.
 * - **A newer proposal for the same agent and symbol replaces it (D400).** The
 *   waiting approval is superseded and its proposal rejected by the system, so
 *   two approvals cannot both fill at the open; the newer proposal says so.
 * - **The tick writes a run only when one is due (D401).** `hasDueOpenApprovals`
 *   is read before the run is claimed.
 * - **A waiting approval sets its cash or shares aside (D428).** It is queued
 *   only when what is free covers it - under the agent's cash lock, so two
 *   approvals cannot both take the last of it - and from then on every other
 *   trade of the agent is checked against what is left (`reservations.ts`).
 * - **The message it was approved on is redrawn (D427).** Once the open settles
 *   an approval, or a newer proposal supersedes it, the Telegram message it was
 *   tapped on loses *Cancel approval* and shows the buttons the row calls for.
 *
 * The approval does not change the proposal's state: it stays `pending` until
 * the fill approves it, so the state machine, the expiry sweep and every other
 * surface read it as they always have.
 */

import {
  feeMinor,
  formatMoney,
  isTradeProposalKind,
  notionalMinor,
  type TradeProposalPayload,
} from '@traders/shared';
import type { AiClient } from '@traders/shared/ai';

import {
  applyProposalTransition,
  cancelOpenApproval,
  findProposal,
  findTradableInstrument,
  getOrCreateUserSettings,
  getUser,
  listDueOpenApprovals,
  lockAgentCash,
  lockAgentHolding,
  queueOpenApproval,
  settleOpenApproval,
  supersedeOpenApprovals,
  transaction,
  type OpenApprovalSurface,
  type ProposalRow,
} from '../db/queries.js';
import { ApiProblem, conflict, notFound, unprocessable } from '../http/errors.js';
import { logger } from '../logger.js';
import { messagesFor, type Messages, type NoticeText, type OpenApprovalFigures } from '../notify/messages.js';
import type { Notifier } from '../notify/notifier.js';
import { redrawProposalMessages } from '../telegram/proposalMessages.js';
import { breachFigures, refusalReason } from '../telegram/tradeApproval.js';
import { fanOut, settingsForNotification } from './notifications.js';
import { factsOf } from './proposals.js';
import { effectiveState } from './proposalState.js';
import { agentReservations, reservedQuantity } from './reservations.js';
import { confirmTradeApproval, previewTradeApproval } from './tradeApproval.js';

/**
 * D399: refusals the next minute may not repeat. The calendar may say closed
 * for a moment after the stored open; a quote may not be fresh in the first
 * seconds (measured: one filled 27 s after the open, none refused as stale);
 * `price_moved` is the ±50 bps between the open's own preview and confirm.
 */
export const TRANSIENT_OPEN_REFUSALS: ReadonlySet<string> = new Set([
  'market_closed',
  'quote_too_old',
  'quote_unavailable',
  'price_moved',
]);

export type QueueOutcome = { outcome: 'queued' | 'unchanged'; opensAt: string };

async function loadTrade(userId: string, proposalId: string): Promise<ProposalRow> {
  const row = await findProposal(userId, proposalId);
  if (row === null) throw notFound('proposal not found');
  if (!isTradeProposalKind(row.kind)) {
    throw unprocessable('not_a_trade', 'only a buy or sell proposal is approved for the open');
  }
  return row;
}

/** Why a proposal cannot be approved for the open now, as Approve's refusals are worded. */
function refuseQueue(row: ProposalRow, now: Date): never {
  const state = effectiveState(factsOf(row), now);
  if (state === 'expired') {
    throw unprocessable('expired', 'this proposal has expired and can no longer be decided', { state });
  }
  if (state !== 'pending') {
    throw unprocessable('already_decided', 'this proposal has already been decided', { state });
  }
  if (row.opens_at === null || row.opens_at.getTime() <= now.getTime()) {
    // The market is open (or was when it was raised): Approve at the live price.
    throw unprocessable('market_open', 'the market is open: approve it at the live price');
  }
  throw unprocessable('open_approval_settled', 'this approval for the open has already been settled', {
    openApproval: row.open_approval,
  });
}

/**
 * Queue the approval if what is free covers it (D428), under the agent's cash
 * lock - the one every fill takes - so the check and the reservation are one
 * step. A buy is measured at the agent's price, the only one there is while the
 * market is closed; the open's fill checks again at the live one.
 *
 * A buy the scan funded with its own sells (`fundedBy`, D197) is queued without
 * the cash check, and sets none aside: its cash arrives when those sells fill,
 * and the open refuses it then if they did not.
 */
async function queueCovered(
  row: ProposalRow,
  userId: string,
  surface: OpenApprovalSurface,
  now: Date,
): Promise<boolean> {
  const payload = row.payload as TradeProposalPayload;
  // Whatever waits is summed by every later check of this agent, so a trade that
  // cannot be measured is refused here, funded or not, and never reaches the queue.
  if (!/^[1-9]\d{0,9}$/.test(String(payload.quantity)) || !Number.isSafeInteger(payload.priceMinor) || payload.priceMinor <= 0) {
    throw unprocessable('invalid_trade', 'this proposal does not name a whole number of shares at a price');
  }
  const instrument = row.kind === 'sell' ? await findTradableInstrument(payload.symbol) : null;
  if (row.kind === 'sell' && instrument === null) throw notFound(`no instrument ${payload.symbol} is known`);
  return transaction(async (client) => {
    const cash = await lockAgentCash(client, userId, row.agent_id);
    // As a fill refuses it (`executeFill`): without the cash row there is no lock to check under.
    if (cash === null) throw conflict('agent_has_no_cash', 'this agent has no cash account');
    const reserved = await agentReservations(userId, row.agent_id, now, { exceptProposalId: row.id, client });
    if (row.kind === 'buy' && (payload.fundedBy ?? []).length === 0) {
      const required = notionalMinor(payload.quantity, BigInt(payload.priceMinor)) + feeMinor(payload.quantity);
      if (cash - reserved.cashMinor < required) {
        throw unprocessable(
          'insufficient_cash',
          reserved.cashMinor > 0n
            ? 'the agent does not have the cash for this trade and its fee: part of its cash is set aside for approved buys'
            : 'the agent does not have the cash for this trade and its fee',
          { cashMinor: Number(cash), reservedMinor: Number(reserved.cashMinor), requiredMinor: Number(required) },
        );
      }
    }
    if (row.kind === 'sell' && instrument !== null) {
      const holding = await lockAgentHolding(client, userId, row.agent_id, instrument.id);
      const held = BigInt((holding?.quantity ?? '0').split('.')[0]!);
      const reservedShares = reservedQuantity(reserved, payload.symbol);
      const quantity = BigInt(payload.quantity.split('.')[0]!);
      if (quantity > held - reservedShares) {
        throw unprocessable(
          'insufficient_holding',
          reservedShares > 0n
            ? `the agent holds ${held} shares, ${reservedShares} of them set aside for approved sells: fewer than ${quantity} are free`
            : `the agent holds ${held} shares, fewer than ${quantity}`,
          { heldQuantity: held.toString(), reservedQuantity: reservedShares.toString() },
        );
      }
    }
    return queueOpenApproval(userId, row.id, surface, now, client);
  });
}

/** *Approve at the open*: queue it, or say why not. A second tap answers `unchanged`. */
export async function approveForOpen(
  userId: string,
  proposalId: string,
  surface: OpenApprovalSurface,
  now: Date = new Date(),
): Promise<QueueOutcome> {
  const row = await loadTrade(userId, proposalId);
  if (row.open_approval === 'queued' && row.opens_at !== null) {
    return { outcome: 'unchanged', opensAt: row.opens_at.toISOString() };
  }
  // Only a proposal that could be queued is measured: one that is decided, expired or
  // past its open is refused for that, below, and never for cash.
  const queueable =
    effectiveState(factsOf(row), now) === 'pending' &&
    row.opens_at !== null &&
    row.opens_at.getTime() > now.getTime() &&
    (row.open_approval === null || row.open_approval === 'cancelled');
  if (queueable && (await queueCovered(row, userId, surface, now))) {
    logger().info({ userId, proposalId, surface }, 'proposal.open_approval_queued');
    return { outcome: 'queued', opensAt: row.opens_at!.toISOString() };
  }
  // Re-read: another surface may have queued it between the read and the write.
  const fresh = await loadTrade(userId, proposalId);
  if (fresh.open_approval === 'queued' && fresh.opens_at !== null) {
    return { outcome: 'unchanged', opensAt: fresh.opens_at.toISOString() };
  }
  refuseQueue(fresh, now);
}

/** *Cancel approval*: take back an approval still waiting. A second tap answers `unchanged`. */
export async function cancelForOpen(
  userId: string,
  proposalId: string,
  surface: OpenApprovalSurface,
): Promise<{ outcome: 'cancelled' | 'unchanged' }> {
  const row = await loadTrade(userId, proposalId);
  if (await cancelOpenApproval(userId, proposalId)) {
    logger().info({ userId, proposalId, surface }, 'proposal.open_approval_cancelled');
    return { outcome: 'cancelled' };
  }
  if (row.open_approval === 'cancelled') return { outcome: 'unchanged' };
  throw unprocessable('open_approval_not_waiting', 'no approval for the open is waiting on this proposal', {
    openApproval: row.open_approval,
  });
}

/**
 * D400: a newer proposal for the same agent and symbol replaces a waiting
 * approval. The older proposal is rejected by the system - it cannot then be
 * approved by hand beside the newer one - and the newer one's message says what
 * it replaced. Answers the replaced trade, or null.
 */
export async function supersedeOlderApprovals(
  userId: string,
  agentId: string,
  symbol: string,
  newerProposalId: string,
  notifier?: Notifier,
  now: Date = new Date(),
): Promise<{ side: 'buy' | 'sell'; quantity: string; symbol: string } | null> {
  const superseded = await supersedeOpenApprovals(userId, agentId, symbol, newerProposalId);
  let replaced: { side: 'buy' | 'sell'; quantity: string; symbol: string } | null = null;
  for (const older of superseded) {
    const row = await findProposal(userId, older.id);
    if (row === null) continue;
    if (row.state === 'pending' || row.state === 'snoozed') {
      await applyProposalTransition({
        proposalId: row.id,
        userId,
        fromState: row.state,
        toState: 'rejected',
        surface: 'system',
        actorUserId: null,
        snoozedUntil: null,
        evidenceSnapshot: row.evidence,
        idempotencyKey: null,
        intent: null,
        revokeIntent: false,
      });
    }
    const payload = row.payload as TradeProposalPayload;
    replaced = { side: row.kind as 'buy' | 'sell', quantity: payload.quantity, symbol: payload.symbol };
    logger().info({ userId, proposalId: row.id, newerProposalId }, 'proposal.open_approval_superseded');
    if (notifier !== undefined) await redrawProposalMessages(notifier, userId, row.id, now);
  }
  return replaced;
}

export interface OpenApprovalTickContext {
  ai: AiClient;
  notifier: Notifier;
  requestId?: string;
  now?: () => Date;
}

export interface OpenApprovalTickResult {
  filled: number;
  refused: number;
  expired: number;
  /** Decided another way meanwhile (approved or rejected by hand): closed without a message. */
  closed: number;
  /** Left waiting for the next minute (D399). */
  retrying: number;
}

/** "16:30" in the user's zone and language. */
function clock(at: Date, timezone: string, messages: Messages): string {
  return new Intl.DateTimeFormat(messages.locale, {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at);
}

/** Tell the user what the open did, in their language, keyed by the proposal: once per approval. */
async function announceOutcome(
  row: ProposalRow,
  notifier: Notifier,
  now: Date,
  text: (messages: Messages, timezone: string) => NoticeText,
): Promise<void> {
  try {
    const [settings, user] = await Promise.all([getOrCreateUserSettings(row.user_id), getUser(row.user_id)]);
    const timezone = user?.timezone ?? 'UTC';
    const english = text(messagesFor('en'), timezone);
    const own = text(messagesFor(settings.language), timezone);
    await fanOut(
      row.user_id,
      row.agent_id,
      [
        {
          refKind: 'open_approval',
          refId: row.id,
          severity: 'notable',
          headline: english.headline,
          explanation: english.explanation,
          localized: settings.language === 'en' ? {} : { [settings.language]: own },
          // It answers the user's own act at a time they chose, like an
          // urgent sell (D70); a mute still holds it for the digest.
          urgent: true,
        },
      ],
      settingsForNotification(settings, timezone),
      notifier,
      now,
    );
  } catch (error) {
    logger().warn({ err: error, proposalId: row.id }, 'proposal.open_approval_announce_failed');
  }
}

function figuresOf(row: ProposalRow): OpenApprovalFigures {
  const payload = row.payload as TradeProposalPayload;
  return { agent: row.agent_name, side: row.kind as 'buy' | 'sell', quantity: payload.quantity, symbol: payload.symbol };
}

type Settled = 'filled' | 'refused' | 'expired' | 'closed' | 'retrying';

/** One waiting approval whose open has come. */
async function settleOne(userId: string, proposalId: string, context: OpenApprovalTickContext): Promise<Settled> {
  const now = (context.now ?? (() => new Date()))();
  const row = await findProposal(userId, proposalId);
  if (row === null || row.open_approval !== 'queued') return 'closed';
  const surface = row.open_approval_surface ?? 'web';
  const state = effectiveState(factsOf(row), now);
  if (state === 'expired') {
    if (await settleOpenApproval(userId, proposalId, 'expired')) {
      await announceOutcome(row, context.notifier, now, (messages) => messages.openApproval.expired(figuresOf(row)));
      logger().info({ userId, proposalId }, 'proposal.open_approval_expired');
    }
    return 'expired';
  }
  if (state !== 'pending') {
    // Approved or rejected by hand since: nothing is left for the open to do.
    await settleOpenApproval(userId, proposalId, 'cancelled');
    return 'closed';
  }

  const user = await getUser(userId);
  const timezone = user?.timezone ?? 'UTC';
  const trade = {
    ai: context.ai,
    timezone,
    now: () => now,
    ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
  };
  try {
    const preview = await previewTradeApproval(userId, proposalId, surface, trade);
    const result = await confirmTradeApproval(userId, proposalId, BigInt(preview.trade.priceMinor), surface, trade, {
      forOpenApproval: true,
    });
    const fill = result.fill;
    await announceOutcome(row, context.notifier, now, (messages) => {
      const money = (minor: number) => formatMoney(minor, fill.currency, { locale: messages.numberLocale });
      const text = messages.openApproval.filled({
        ...figuresOf(row),
        price: money(fill.priceMinor),
        fee: money(fill.feeMinor),
        cash: money(result.cashMinor),
      });
      // A limit the buy went past is said, as the preview says it (D299): the
      // approval was the user's explicit act, so it filled.
      const breaches = preview.mandateBreaches.map((breach) =>
        messages.trade.mandateBreach(breachFigures(breach, fill.symbol, messages)),
      );
      return breaches.length === 0
        ? text
        : { headline: text.headline, explanation: [text.explanation, ...breaches].join('\n') };
    });
    logger().info({ userId, proposalId, fillId: fill.id }, 'proposal.open_approval_filled');
    return 'filled';
  } catch (error) {
    if (!(error instanceof ApiProblem)) {
      // The AI service or the database did not answer: the next minute asks again.
      logger().warn({ err: error, userId, proposalId }, 'proposal.open_approval_retry');
      return 'retrying';
    }
    if (error.status >= 500 || TRANSIENT_OPEN_REFUSALS.has(error.code)) {
      logger().info({ userId, proposalId, reason: error.code }, 'proposal.open_approval_retry');
      return 'retrying';
    }
    if (error.code === 'open_approval_gone' || error.code === 'already_decided' || error.status === 404) {
      await settleOpenApproval(userId, proposalId, 'cancelled');
      return 'closed';
    }
    if (error.code === 'expired') {
      if (await settleOpenApproval(userId, proposalId, 'expired')) {
        await announceOutcome(row, context.notifier, now, (messages) => messages.openApproval.expired(figuresOf(row)));
      }
      return 'expired';
    }
    if (await settleOpenApproval(userId, proposalId, 'refused', error.code.slice(0, 64))) {
      await announceOutcome(row, context.notifier, now, (messages, zone) =>
        messages.openApproval.refused({
          ...figuresOf(row),
          reason: refusalReason(error, messages, zone),
          until: clock(row.expires_at, zone, messages),
        }),
      );
      logger().info({ userId, proposalId, reason: error.code }, 'proposal.open_approval_refused');
    }
    return 'refused';
  }
}

/** The minute tick (D401): every approval whose open has come, in turn. */
export async function fillDueOpenApprovals(context: OpenApprovalTickContext): Promise<OpenApprovalTickResult> {
  const now = (context.now ?? (() => new Date()))();
  const result: OpenApprovalTickResult = { filled: 0, refused: 0, expired: 0, closed: 0, retrying: 0 };
  for (const due of await listDueOpenApprovals(now)) {
    let outcome: Settled;
    try {
      outcome = await settleOne(due.user_id, due.id, context);
    } catch (error) {
      // One account's failure is its own; the next approval still runs.
      logger().warn({ err: error, proposalId: due.id }, 'proposal.open_approval_failed');
      outcome = 'retrying';
    }
    result[outcome] += 1;
    // Settled one way or another: the message it was approved on no longer offers Cancel (D427).
    if (outcome !== 'retrying') await redrawProposalMessages(context.notifier, due.user_id, due.id, now);
  }
  return result;
}
