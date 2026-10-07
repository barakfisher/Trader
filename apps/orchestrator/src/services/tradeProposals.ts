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

import { createTradeProposal, type AgentRow } from '../db/queries.js';
import { upstreamFailure } from '../http/errors.js';
import { logger } from '../logger.js';
import { messagesFor } from '../notify/messages.js';
import { resolveTradable } from './fills.js';

/** D4: P4's sixty minutes, counted from the next market open. */
export const TRADE_PROPOSAL_TTL_MS = 60 * 60 * 1000;

/** `max(now, next open) + TTL`: an open market counts from now, a closed one from its open (D4). */
export function tradeProposalExpiry(now: Date, calendar: { is_open: boolean; next_open: string }): Date {
  const opens = calendar.is_open ? now.getTime() : Math.max(now.getTime(), Date.parse(calendar.next_open));
  return new Date(opens + TRADE_PROPOSAL_TTL_MS);
}

export interface TradeProposalContext {
  ai: AiClient;
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

  const proposalId = await createTradeProposal({
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
  return proposalId;
}
