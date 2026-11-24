/**
 * Approving a trade for the open from Telegram (D398): *Approve at the open*
 * queues it, *Cancel approval* takes it back. The rules are
 * `services/openApproval.ts`, the same ones the web calls; this module turns
 * their answers into a chat, the way `tradeApproval.ts` does for Approve.
 *
 * A tap on *Approve at the open* after the market has opened is answered as
 * Approve: the preview at the live price. The message may be read long after it
 * was sent, and the button it carries is the one that was right then.
 *
 * The message *Approve at the open* was tapped on is remembered, so the open can
 * take *Cancel approval* off it when it settles the approval (D427).
 *
 * Nothing here throws to its caller (`updates.ts`): every failure ends in a
 * toast and a keyboard that matches the proposal's real state.
 */

import type { AiClient } from '@traders/shared/ai';

import { getUser, rememberTelegramProposalMessage } from '../db/queries.js';
import { ApiProblem } from '../http/errors.js';
import { logger } from '../logger.js';
import { messagesFor, type Messages } from '../notify/messages.js';
import { approveForOpen, cancelForOpen } from '../services/openApproval.js';
import type { CallbackPayload } from './callbackToken.js';
import type { Keyboard, TelegramNotifier } from './client.js';
import { recheckOffered } from './proposalRecheck.js';
import { appendBlock, currentKeyboard, handleTradeCallback, refusalReason, stamp } from './tradeApproval.js';

export interface OpenApprovalCallback {
  telegram: TelegramNotifier | null;
  ai: AiClient;
  userId: string;
  language: string;
  callbackId: string;
  chatId: string;
  message?: { message_id: number; text?: string; fromPending?: boolean };
  payload: CallbackPayload & { action: 'queue' | 'unqueue' };
  now?: () => Date;
}

/** "16:30" - or "Thu 16:30" when the open is on a later local day - in the user's zone. */
function opening(iso: string, now: Date, timezone: string, messages: Messages): string {
  const opens = new Date(iso);
  const day = (at: Date) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  return new Intl.DateTimeFormat(messages.locale, {
    timeZone: timezone,
    ...(day(opens) === day(now) ? {} : { weekday: 'short' }),
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(opens);
}

export async function handleOpenApprovalCallback(input: OpenApprovalCallback): Promise<void> {
  const { telegram, userId, payload, message, chatId } = input;
  const messages = messagesFor(input.language);
  const now = (input.now ?? (() => new Date()))();
  const timezone = (await getUser(userId))?.timezone ?? 'UTC';

  if (telegram !== null && message !== undefined) {
    await telegram.showWorking(chatId, message.message_id, payload.action, input.language);
  }

  let toast: string;
  let block: string | null = null;
  let keyboard: Keyboard;
  let result: string;
  try {
    if (payload.action === 'queue') {
      const queued = await approveForOpen(userId, payload.proposalId, 'telegram', now);
      toast = messages.openApproval.queuedToast;
      block =
        queued.outcome === 'queued'
          ? messages.openApproval.queued(opening(queued.opensAt, now, timezone, messages), stamp(now, timezone, messages))
          : null;
      keyboard = 'openQueued';
      result = queued.outcome;
      // The open redraws this message when it settles the approval (D427).
      if (message !== undefined) {
        await rememberTelegramProposalMessage(
          userId,
          payload.proposalId,
          chatId,
          message.message_id,
          message.fromPending === true,
        ).catch((error: unknown) =>
          logger().warn({ err: error, proposalId: payload.proposalId }, 'telegram.proposal_message_remember_failed'),
        );
      }
    } else {
      const cancelled = await cancelForOpen(userId, payload.proposalId, 'telegram');
      toast = messages.openApproval.cancelledToast;
      block = cancelled.outcome === 'cancelled' ? messages.openApproval.cancelled(stamp(now, timezone, messages)) : null;
      keyboard = await currentKeyboard(userId, payload.proposalId, now);
      result = cancelled.outcome;
    }
  } catch (error) {
    if (error instanceof ApiProblem && error.code === 'market_open') {
      // The market has opened since the message was sent: this tap is Approve.
      logger().info({ userId, proposalId: payload.proposalId }, 'telegram.open_approval_after_open');
      await handleTradeCallback({ ...input, payload: { ...payload, action: 'approve' } });
      return;
    }
    if (!(error instanceof ApiProblem)) {
      logger().error({ err: error, proposalId: payload.proposalId }, 'telegram.open_approval_failed');
      toast = messages.trade.reasons.other;
      result = 'failed';
    } else if (error.status === 404) {
      toast = messages.proposalGone;
      result = 'gone';
    } else if (error.code === 'expired') {
      toast = messages.decisionReplies.expired ?? messages.cannotChange;
      block = `${messages.outcomeLines.expired ?? messages.nowState('expired')} (${stamp(now, timezone, messages)})`;
      result = 'expired';
    } else if (error.code === 'already_decided') {
      toast = messages.refusalReplies.already_decided ?? messages.cannotChange;
      result = 'already_decided';
    } else if (error.code === 'insufficient_cash' || error.code === 'insufficient_holding') {
      // What is free does not cover it (D428): said in full, and the proposal stays open.
      toast = refusalReason(error, messages, timezone);
      result = error.code;
    } else {
      // Nothing waiting to cancel, or an approval the open already settled.
      toast = messages.openApproval.notWaitingToast;
      result = error.code;
    }
    keyboard =
      result === 'expired' && (await recheckOffered(userId, payload.proposalId))
        ? 'recheck'
        : await currentKeyboard(userId, payload.proposalId, now);
  }

  logger().info({ userId, proposalId: payload.proposalId, action: payload.action, result }, 'telegram.open_approval');

  await telegram?.answerCallback(input.callbackId, toast);
  if (telegram === null || message === undefined) return;
  const backToPending = message.fromPending === true;
  const edited =
    block === null
      ? await telegram.setKeyboard(chatId, message.message_id, payload.proposalId, keyboard, input.language, {
          backToPending,
        })
      : await telegram.editMessage(chatId, message.message_id, appendBlock(message.text ?? '', block), {
          proposalId: payload.proposalId,
          keyboard,
          language: input.language,
          backToPending,
        });
  if (!edited.delivered) {
    logger().warn({ chatId, messageId: message.message_id, err: edited.error }, 'telegram.edit_failed');
  }
}
