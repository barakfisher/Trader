/**
 * A scan's buy or sell becomes a trade proposal (Stage 4, PR 5a; D26, D4, D51).
 *
 * The AI service ran the scan and checked its answer - tradable symbol, whole
 * shares, a sell within holdings, every thesis figure sourced, and cash for
 * cost plus fee at the agent's price (D54, D55) - so a `trade` outcome reaching
 * here is one that may be proposed. This module writes it: an observation
 * carrying the thesis, and a `buy` or `sell` proposal hanging from it with the
 * agent's price, expiring an hour after the next open (D4).
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

import { createTradeProposal, getOrCreateUserSettings, getUser, type AgentRow } from '../db/queries.js';
import { upstreamFailure } from '../http/errors.js';
import { logger } from '../logger.js';
import { messagesFor } from '../notify/messages.js';
import type { Notifier } from '../notify/notifier.js';
import { resolveTradable } from './fills.js';
import { fanOut, settingsForNotification } from './notifications.js';

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

/**
 * Write the proposal a `trade` scan made, and answer its id; null for any other
 * outcome. Idempotent per scan (`createTradeProposal`).
 */
export async function proposeFromScan(
  userId: string,
  agent: AgentRow,
  scan: AgentScanResponse,
  context: TradeProposalContext,
): Promise<string | null> {
  const answer = scan.answer;
  if (scan.outcome !== 'trade' || !answer) return null;
  const { decision, symbol, quantity, thesis, price_minor: priceMinor } = answer;
  if ((decision !== 'buy' && decision !== 'sell') || !symbol || !quantity || !thesis || !priceMinor) {
    // The AI service's contract says a `trade` carries all of these; one that
    // does not is a bug there, and proposing half a trade would hide it.
    throw new Error(`scan ${scan.scan_id} is a trade with an incomplete answer`);
  }
  const kind: TradeProposalKind = decision;
  const now = (context.now ?? (() => new Date()))();

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

  const payload: TradeProposalPayload = {
    symbol: instrument.symbol,
    quantity,
    priceMinor,
    priceAsOf: answer.price_as_of ?? null,
    currency: 'USD',
  };
  const price = minorToDecimalString(priceMinor, 'USD');
  const headlineIn = (language: string) =>
    messagesFor(language).tradeProposalHeadline(agent.name, kind, quantity, instrument.symbol, price);
  const localized: LocalizedTexts = Object.fromEntries(
    UI_LANGUAGES.filter((language): language is TranslatedLanguage => language !== 'en').map((language) => [
      language,
      { headline: headlineIn(language), explanation: thesis },
    ]),
  );

  const { proposalId, observationId } = await createTradeProposal({
    userId,
    agentId: agent.id,
    scanId: scan.scan_id,
    kind,
    payload,
    expiresAt: tradeProposalExpiry(now, calendar),
    headline: headlineIn('en'),
    thesis,
    localized,
    evidence: { scanId: scan.scan_id, ...payload, thesis },
  });
  logger().info({ proposalId, scanId: scan.scan_id, agentId: agent.id, kind }, 'proposal.trade_raised');

  await announce(userId, agent, context.notifier, now, {
    observationId,
    proposalId,
    headline: headlineIn('en'),
    thesis,
    localized,
  });
  return proposalId;
}

/**
 * Tell the user, with Approve and Reject on the message (D60, D61). Every scan
 * that proposes announces it - a manual one too: whoever pressed *Run* may have
 * left the page by the time it answers, and the proposal lives an hour.
 *
 * The floor is ignored, quiet hours and a mute are not (`routeFinding`). Keyed
 * by the observation, so a retried scan never announces twice. A failure to
 * announce is logged and swallowed: the proposal is written and on the
 * dashboard, and a scan must not report failure for a message.
 */
async function announce(
  userId: string,
  agent: AgentRow,
  notifier: Notifier,
  now: Date,
  proposal: { observationId: string; proposalId: string; headline: string; thesis: string; localized: LocalizedTexts },
): Promise<void> {
  try {
    const [settings, user] = await Promise.all([getOrCreateUserSettings(userId), getUser(userId)]);
    await fanOut(
      userId,
      agent.id,
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
        },
      ],
      settingsForNotification(settings, user?.timezone ?? 'UTC'),
      notifier,
      now,
    );
  } catch (error) {
    logger().warn({ err: error, proposalId: proposal.proposalId }, 'proposal.trade_announce_failed');
  }
}
