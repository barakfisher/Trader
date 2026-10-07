/**
 * Approving an agent's trade from Telegram: *Approve* previews at the live
 * price, *Confirm* fills at the price that preview showed (D47, D61-D62).
 *
 * The money path is `services/tradeApproval.ts`, the same one the dashboard
 * calls, with `surface: 'telegram'`; this module only turns its answers into a
 * chat. Three things it adds:
 *
 * - **The previewed price rides in the Confirm button.** `callbackToken.ts`
 *   signs it with the proposal and the action, so the ±50 bps band a fill is
 *   checked against is centred on the price the user read - never one an
 *   edited button names. The server computes every bound, as on the web.
 * - **The message keeps the record.** The preview, the fill and each refusal
 *   are appended under the proposal, as the other decisions' outcome lines
 *   are, so the chat read tomorrow says what happened and at what price.
 * - **A refusal keeps Approve and Reject (D49, D62).** The proposal is still
 *   pending; the reason is shown in the user's language, a closed market with
 *   its next open in the user's own time, and the attempt is recorded by the
 *   service. There is no Confirm without a fresh preview.
 *
 * Nothing here throws to its caller (`updates.ts`): every failure ends in a
 * toast and a keyboard that matches the proposal's real state.
 */

import { formatMoney } from '@traders/shared';
import type { AiClient } from '@traders/shared/ai';

import { getUser } from '../db/queries.js';
import { ApiProblem } from '../http/errors.js';
import { logger } from '../logger.js';
import {
  messagesFor,
  type Messages,
  type TradeRefusalCode,
} from '../notify/messages.js';
import { DEFAULT_RANGE_BPS } from '../services/fills.js';
import { confirmTradeApproval, previewTradeApproval } from '../services/tradeApproval.js';
import type { CallbackPayload } from './callbackToken.js';
import { confirmable, type Keyboard, type TelegramNotifier } from './client.js';

export interface TradeCallback {
  telegram: TelegramNotifier | null;
  ai: AiClient;
  userId: string;
  language: string;
  callbackId: string;
  chatId: string;
  message?: { message_id: number; text?: string };
  payload: CallbackPayload & { action: 'approve' | 'confirm' };
  now?: () => Date;
}

const REFUSAL_CODES = new Set<string>([
  'quote_too_old',
  'quote_unavailable',
  'price_moved',
  'insufficient_cash',
  'insufficient_holding',
  'not_tradable',
  'agent_archived',
] satisfies TradeRefusalCode[]);

/** Basis points as a signed percentage with two decimals, in integers: 25 -> "+0.25%". */
export function bpsAsPercent(bps: number, signed = true): string {
  const sign = bps < 0 ? '-' : signed ? '+' : '';
  const magnitude = Math.abs(Math.trunc(bps));
  return `${sign}${Math.floor(magnitude / 100)}.${String(magnitude % 100).padStart(2, '0')}%`;
}

function stamp(now: Date, timezone: string, messages: Messages): string {
  return new Intl.DateTimeFormat(messages.locale, {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
}

/** The next open as the user reads it: weekday, date and time in their zone. */
function openingTime(iso: string, timezone: string, messages: Messages): string {
  return new Intl.DateTimeFormat(messages.locale, {
    timeZone: timezone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

/** A refusal's reason in the user's language, with the figures it carried. */
export function refusalReason(error: ApiProblem, messages: Messages, timezone: string): string {
  const details = (error.details ?? {}) as Record<string, unknown>;
  const money = (minor: unknown) =>
    typeof minor === 'number' ? formatMoney(minor, 'USD', { locale: messages.numberLocale }) : '—';
  if (error.code === 'market_closed' && typeof details.nextOpen === 'string') {
    return messages.trade.marketClosed(openingTime(details.nextOpen, timezone, messages));
  }
  if (error.code === 'price_far_from_agent' && typeof details.distanceBps === 'number') {
    return messages.trade.farFromAgent(
      money(details.agentPriceMinor),
      money(details.livePriceMinor),
      bpsAsPercent(details.distanceBps),
    );
  }
  return messages.trade.reasons[REFUSAL_CODES.has(error.code) ? (error.code as TradeRefusalCode) : 'other'];
}

function appendBlock(text: string, block: string): string {
  return text === '' ? block : `${text}\n\n${block}`;
}

export async function handleTradeCallback(input: TradeCallback): Promise<void> {
  const { telegram, userId, payload, message, chatId } = input;
  const messages = messagesFor(input.language);
  const now = (input.now ?? (() => new Date()))();
  const timezone = (await getUser(userId))?.timezone ?? 'UTC';
  const context = { ai: input.ai, timezone, now: () => now };

  if (telegram !== null && message !== undefined) {
    await telegram.showWorking(chatId, message.message_id, payload.action, input.language);
  }

  let toast: string;
  let block: string | null;
  let keyboard: Keyboard;
  try {
    if (payload.action === 'approve') {
      const preview = await previewTradeApproval(userId, payload.proposalId, 'telegram', context);
      const trade = preview.trade;
      const money = (minor: number) => formatMoney(minor, trade.currency, { locale: messages.numberLocale });
      const live = BigInt(trade.priceMinor);
      toast = messages.trade.previewToast;
      block = messages.trade.preview({
        side: trade.side,
        quantity: trade.quantity,
        symbol: trade.symbol,
        livePrice: money(trade.priceMinor),
        agentPrice: money(preview.agentPriceMinor),
        distance: bpsAsPercent(preview.distanceBps),
        notional: money(trade.notionalMinor),
        fee: money(trade.feeMinor),
        cashAfter: money(trade.cashAfterMinor),
        band: bpsAsPercent(Number(DEFAULT_RANGE_BPS), false),
      });
      if (!confirmable(live)) block = `${block}\n${messages.trade.confirmInApp}`;
      keyboard = { confirmAt: live };
    } else {
      const result = await confirmTradeApproval(
        userId,
        payload.proposalId,
        payload.priceMinor!,
        'telegram',
        context,
      );
      const money = (minor: number) => formatMoney(minor, result.fill.currency, { locale: messages.numberLocale });
      toast = messages.trade.filledToast;
      block = messages.trade.filled({
        side: result.fill.side,
        quantity: result.fill.quantity,
        symbol: result.fill.symbol,
        price: money(result.fill.priceMinor),
        fee: money(result.fill.feeMinor),
        cash: money(result.cashMinor),
        at: stamp(now, timezone, messages),
      });
      keyboard = 'none';
    }
  } catch (error) {
    if (!(error instanceof ApiProblem)) {
      logger().error({ err: error, proposalId: payload.proposalId }, 'telegram.trade_callback_failed');
      toast = messages.trade.reasons.other;
      block = null;
      keyboard = 'trade';
    } else if (error.status === 404) {
      toast = messages.proposalGone;
      block = null;
      keyboard = 'none';
    } else if (error.code === 'expired') {
      toast = messages.decisionReplies.expired ?? messages.cannotChange;
      block = `${messages.outcomeLines.expired ?? messages.nowState('expired')} (${stamp(now, timezone, messages)})`;
      keyboard = 'none';
    } else if (error.code === 'already_decided') {
      toast = messages.refusalReplies.already_decided ?? messages.cannotChange;
      block = null;
      keyboard = 'none';
    } else {
      // A refusal of the trade itself (D49): recorded by the service, still pending.
      const reason = refusalReason(error, messages, timezone);
      toast = reason;
      block = messages.trade.refused(reason, stamp(now, timezone, messages));
      keyboard = 'trade';
    }
  }

  // The toast first: it is what the user is waiting on.
  await telegram?.answerCallback(input.callbackId, toast);
  if (telegram === null || message === undefined) return;

  const edited =
    block === null
      ? await telegram.setKeyboard(chatId, message.message_id, payload.proposalId, keyboard, input.language)
      : await telegram.editMessage(chatId, message.message_id, appendBlock(message.text ?? '', block), {
          proposalId: payload.proposalId,
          keyboard,
          language: input.language,
        });
  if (!edited.delivered) {
    logger().warn({ chatId, messageId: message.message_id, err: edited.error }, 'telegram.edit_failed');
  }
}
