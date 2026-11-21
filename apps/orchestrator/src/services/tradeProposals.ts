/**
 * A scan's buy or sell becomes a trade proposal (Stage 4, PR 5a; D26, D4, D51).
 *
 * The AI service ran the scan and checked its answer - tradable symbol, whole
 * shares, a sell within holdings, every thesis figure sourced, and cash for
 * cost plus fee at the agent's price (D54, D55) - so a `trade` outcome reaching
 * here is one that may be proposed. This module writes each trade the scan
 * kept (D197, up to the agent's `max_decisions`): an observation carrying its
 * thesis, and a `buy` or `sell` proposal hanging from it with the agent's
 * price, expiring an hour after the next open (D4). A buy paid for by a sell
 * from the same scan says so in its headline: the user approves the sell first.
 *
 * **The frame is the catalogue's, the thesis the model's (D51).** The headline -
 * agent, side, quantity, symbol, price - is written from `notify/messages.ts` in
 * every language; the thesis is stored as the model wrote it, in the user's
 * language, and is the same text under every headline.
 *
 * The primary never gets here: it never scans (D1), and the database's
 * allowlist (0038) would refuse a `buy` on it if anything tried.
 */

import {
  minorToDecimalString,
  UI_LANGUAGES,
  type LocalizedTexts,
  type TradeProposalKind,
  type TradeProposalPayload,
  type TranslatedLanguage,
} from '@traders/shared';
import { AiServiceError, type AgentScanResponse, type AiClient } from '@traders/shared/ai';

import {
  createTradeProposal,
  getOrCreateUserSettings,
  getUser,
  listHeldTradeProposals,
  listScanToolCalls,
  type AgentRow,
  type HeldTradeProposalRow,
} from '../db/queries.js';
import { upstreamFailure } from '../http/errors.js';
import { logger } from '../logger.js';
import { messagesFor } from '../notify/messages.js';
import type { Notifier } from '../notify/notifier.js';
import { evidenceCheckedFrom } from './evidenceChecked.js';
import { resolveTradable } from './fills.js';
import { routeFinding } from './notificationPolicy.js';
import { fanOut, settingsForNotification, type NotifiableFinding } from './notifications.js';
import { supersedeOlderApprovals } from './openApproval.js';

/** D4: P4's sixty minutes, counted from the next market open. */
export const TRADE_PROPOSAL_TTL_MS = 60 * 60 * 1000;

/** `max(now, next open) + TTL`: an open market counts from now, a closed one from its open (D4). */
export function tradeProposalExpiry(now: Date, calendar: { is_open: boolean; next_open: string }): Date {
  const opens = calendar.is_open ? now.getTime() : Math.max(now.getTime(), Date.parse(calendar.next_open));
  return new Date(opens + TRADE_PROPOSAL_TTL_MS);
}

export interface TradeProposalContext {
  ai: AiClient;
  /** Announces the proposal (D60, D61): the user is the one who approves it. */
  notifier: Notifier;
  requestId?: string;
  now?: () => Date;
}

type ScanTrade = NonNullable<NonNullable<AgentScanResponse['answer']>['trades']>[number];

/**
 * Write a proposal for each trade a `trade` scan kept, sells first as the scan
 * reviewed them, and answer their ids; none for any other outcome. Each is
 * approved on its own (D197). Idempotent per scan and symbol (`createTradeProposal`).
 */
export async function proposeFromScan(
  userId: string,
  agent: AgentRow,
  scan: AgentScanResponse,
  context: TradeProposalContext,
): Promise<string[]> {
  const kept = (scan.answer?.trades ?? []).filter((trade) => !trade.refused);
  if (scan.outcome !== 'trade' || kept.length === 0) return [];
  const now = (context.now ?? (() => new Date()))();
  const ids: string[] = [];
  for (const trade of kept) {
    ids.push(await proposeTrade(userId, agent, scan.scan_id, trade, context, now));
  }
  return ids;
}

async function proposeTrade(
  userId: string,
  agent: AgentRow,
  scanId: string,
  trade: ScanTrade,
  context: TradeProposalContext,
  now: Date,
): Promise<string> {
  const { decision, symbol, quantity, thesis, price_minor: priceMinor } = trade;
  if ((decision !== 'buy' && decision !== 'sell') || !symbol || !quantity || !thesis || !priceMinor) {
    // The AI service's contract says a kept trade carries all of these; one that
    // does not is a bug there, and proposing half a trade would hide it.
    throw new Error(`scan ${scanId} kept a trade with an incomplete answer`);
  }
  const kind: TradeProposalKind = decision;

  const instrument = await resolveTradable(symbol);
  let calendar;
  try {
    calendar = await context.ai.marketCalendar(instrument.exchange ?? '', context.requestId);
  } catch (error) {
    if (error instanceof AiServiceError) {
      throw upstreamFailure(error.status, 'The scan proposed a trade, but the exchange calendar could not be read.');
    }
    throw error;
  }

  const fundedBy = kind === 'buy' ? (trade.funded_by ?? []) : [];
  const payload: TradeProposalPayload = {
    symbol: instrument.symbol,
    quantity,
    priceMinor,
    priceAsOf: trade.price_as_of ?? null,
    currency: 'USD',
    ...(fundedBy.length > 0 ? { fundedBy } : {}),
  };
  const price = minorToDecimalString(priceMinor, 'USD');
  const headlineIn = (language: string) => {
    const messages = messagesFor(language);
    const headline = messages.tradeProposalHeadline(agent.name, kind, quantity, instrument.symbol, price);
    return fundedBy.length > 0 ? `${headline}${messages.tradeFundedBy(fundedBy)}` : headline;
  };
  const localized: LocalizedTexts = Object.fromEntries(
    UI_LANGUAGES.filter((language): language is TranslatedLanguage => language !== 'en').map((language) => [
      language,
      { headline: headlineIn(language), explanation: thesis },
    ]),
  );

  const { proposalId, observationId } = await createTradeProposal({
    userId,
    agentId: agent.id,
    scanId,
    kind,
    payload,
    expiresAt: tradeProposalExpiry(now, calendar),
    // D398: what a surface reads to offer Approve at the open instead of Approve.
    opensAt: calendar.is_open ? null : new Date(calendar.next_open),
    headline: headlineIn('en'),
    thesis,
    localized,
    evidence: { scanId, ...payload, thesis },
  });
  logger().info({ proposalId, scanId, agentId: agent.id, kind }, 'proposal.trade_raised');
  // D400: a newer proposal replaces an approval for the open still waiting on
  // the same symbol, whichever side it is; the message says which it replaced.
  const replaced = await supersedeOlderApprovals(userId, agent.id, instrument.symbol, proposalId);

  await announce(userId, agent.id, context.notifier, now, {
    observationId,
    proposalId,
    scanId,
    // D70: a sell that can be approved right now does not wait for the morning.
    urgent: kind === 'sell' && calendar.is_open,
    marketOpensAt: calendar.is_open ? undefined : calendar.next_open,
    replaced,
    headline: headlineIn('en'),
    thesis,
    localized,
  });
  return proposalId;
}

/**
 * Tell the user, with Approve and Reject on the message (D60, D61), and what the
 * scan checked before proposing, so the trade can be judged from the message. Every scan
 * that proposes announces it - a manual one too: whoever pressed *Run* may have
 * left the page by the time it answers, and the proposal lives an hour.
 *
 * The floor is ignored, quiet hours and a mute are not (`routeFinding`): held
 * by either, it goes to the digest, and `announceHeldTradeProposals` sends it
 * when the hold ends (D420). Keyed by the observation and the channel, so a
 * retried scan never announces twice. A failure to announce is logged and
 * swallowed: the proposal is written and on the dashboard, and a scan must not
 * report failure for a message. Answers how many messages went out.
 */
async function announce(
  userId: string,
  agentId: string,
  notifier: Notifier,
  now: Date,
  proposal: {
    observationId: string;
    proposalId: string;
    scanId: string;
    urgent: boolean;
    marketOpensAt: string | undefined;
    replaced: { side: 'buy' | 'sell'; quantity: string; symbol: string } | null;
    heldSince?: NonNullable<NotifiableFinding['heldSince']>;
    headline: string;
    thesis: string;
    localized: LocalizedTexts;
  },
): Promise<number> {
  try {
    const [settings, user, toolCalls] = await Promise.all([
      getOrCreateUserSettings(userId),
      getUser(userId),
      listScanToolCalls(userId, agentId, proposal.scanId),
    ]);
    const result = await fanOut(
      userId,
      agentId,
      [
        {
          refKind: 'observation',
          refId: proposal.observationId,
          severity: 'notable',
          headline: proposal.headline,
          explanation: proposal.thesis,
          localized: proposal.localized,
          proposalId: proposal.proposalId,
          trade: true,
          urgent: proposal.urgent,
          ...(proposal.marketOpensAt !== undefined ? { marketOpensAt: proposal.marketOpensAt } : {}),
          ...(proposal.replaced !== null ? { replacesOpenApproval: proposal.replaced } : {}),
          ...(proposal.heldSince !== undefined ? { heldSince: proposal.heldSince } : {}),
          evidenceChecked: evidenceCheckedFrom(toolCalls),
        },
      ],
      settingsForNotification(settings, user?.timezone ?? 'UTC'),
      notifier,
      now,
    );
    return result.pushed;
  } catch (error) {
    logger().warn({ err: error, proposalId: proposal.proposalId }, 'proposal.trade_announce_failed');
    return 0;
  }
}

/**
 * Announce the trade proposals whose hold has ended (D420), and answer how many.
 *
 * A proposal raised in the user's quiet hours, or while they were muted, went
 * to the digest, which only counts it: measured on production (2026-11-20),
 * all three proposals of a scan that runs at 23:15 expired unseen, while every
 * approved one had been decided in Telegram within 80 minutes. So the proposal
 * sweep asks here every quarter hour: a held proposal that is still open, once
 * its user may be interrupted again, is sent as it would have been - thesis,
 * evidence checked, Approve (at the open, while the market is closed) and
 * Reject - under a first line saying when it was raised.
 *
 * Idempotent by the same key as the first announcement: the claim on the
 * channel is taken before the send, and a proposal with a row there is no
 * longer listed. One still held is skipped without reading its scan.
 *
 * A sell raised into an open market keeps its urgency (D70): only a mute could
 * have held it, and when the mute ends it does not wait for quiet hours too.
 *
 * Not carried over: the line naming an approval for the open this proposal
 * replaced (D400). That was known when it was raised and is stored nowhere.
 * Not known here: whether a market that was open when the proposal was raised
 * has closed since. Such a proposal lives an hour, and Approve says so.
 *
 * Never throws: the sweep that calls it has already expired proposals, and a
 * message that could not be sent must not report that run as failed.
 */
export async function announceHeldTradeProposals(notifier: Notifier, now: Date = new Date()): Promise<number> {
  let heldProposals: HeldTradeProposalRow[];
  try {
    heldProposals = await listHeldTradeProposals(notifier.channel, now);
  } catch (error) {
    logger().warn({ err: error }, 'proposal.held_list_failed');
    return 0;
  }
  let announced = 0;
  for (const held of heldProposals) {
    try {
      const [settings, user] = await Promise.all([getOrCreateUserSettings(held.user_id), getUser(held.user_id)]);
      const routing = settingsForNotification(settings, user?.timezone ?? 'UTC');
      const urgent = held.kind === 'sell' && held.opens_at === null;
      const route = routeFinding('notable', routing, now, { floor: 'ignored', quietHours: urgent ? 'ignored' : 'apply' });
      if (route.route !== 'push') continue;
      const stillClosed = held.opens_at !== null && held.opens_at.getTime() > now.getTime();
      announced += await announce(held.user_id, held.agent_id, notifier, now, {
        observationId: held.observation_id,
        proposalId: held.proposal_id,
        scanId: held.scan_id,
        urgent,
        marketOpensAt: stillClosed ? held.opens_at!.toISOString() : undefined,
        replaced: null,
        heldSince: { raisedAt: held.created_at.toISOString(), reason: held.held_reason },
        headline: held.headline,
        thesis: held.explanation,
        localized: held.localized,
      });
    } catch (error) {
      // One user's proposal must not stop the others'.
      logger().warn({ err: error, proposalId: held.proposal_id }, 'proposal.held_announce_failed');
    }
  }
  if (announced > 0) logger().info({ announced }, 'proposal.held_announced');
  return announced;
}
