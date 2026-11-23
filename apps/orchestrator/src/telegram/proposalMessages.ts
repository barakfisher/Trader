/**
 * Redraw the Telegram messages that show a proposal after it changed somewhere
 * else (D427).
 *
 * A message's buttons are the ones that were right when it was last drawn. A
 * tap redraws its own message, but a change made by the server - the open
 * filling, refusing or expiring an approval - touched no message, so the one the
 * approval was tapped on kept *Cancel approval* after the trade had filled
 * (production, 2026-11-23). The tapped message is now remembered
 * (`telegram_proposal_messages`), and redrawn from the proposal's row here.
 *
 * Only the buttons are redrawn: the text is the message's own, and what the
 * open did is said by the message the open sends. Never throws: a message that
 * could not be edited is a stale button, never a failed fill.
 */

import { forgetTelegramMessage, getOrCreateUserSettings, listTelegramProposalMessages } from '../db/queries.js';
import { logger } from '../logger.js';
import type { Notifier } from '../notify/notifier.js';
import { TelegramNotifier } from './client.js';
import { currentKeyboard } from './tradeApproval.js';

/** Telegram's answer to an edit that changes nothing: the message already shows it. */
export const NOT_MODIFIED = /message is not modified/i;

export async function redrawProposalMessages(
  notifier: Notifier,
  userId: string,
  proposalId: string,
  now: Date = new Date(),
): Promise<void> {
  if (!(notifier instanceof TelegramNotifier)) return;
  try {
    const shown = await listTelegramProposalMessages(userId, proposalId);
    if (shown.length === 0) return;
    const [keyboard, { language }] = await Promise.all([
      currentKeyboard(userId, proposalId, now),
      getOrCreateUserSettings(userId),
    ]);
    for (const message of shown) {
      const edited = await notifier.setKeyboard(
        message.chat_id,
        Number(message.message_id),
        proposalId,
        keyboard,
        language,
        { backToPending: message.back_to_pending },
      );
      if (!edited.delivered && !NOT_MODIFIED.test(edited.error ?? '')) {
        logger().warn(
          { userId, proposalId, messageId: message.message_id, err: edited.error },
          'telegram.proposal_redraw_failed',
        );
      }
    }
    logger().info({ userId, proposalId, keyboard, messages: shown.length }, 'telegram.proposal_redrawn');
  } catch (error) {
    logger().warn({ err: error, userId, proposalId }, 'telegram.proposal_redraw_failed');
  }
}

/**
 * A message the menu moved to another view no longer shows the proposal it was
 * remembered for: redrawing it with that proposal's buttons would put them under
 * the wrong text. Never throws: the menu's own edit already happened.
 */
export async function forgetRedrawnMessage(chatId: string, messageId: number): Promise<void> {
  try {
    await forgetTelegramMessage(chatId, messageId);
  } catch (error) {
    logger().warn({ err: error, messageId }, 'telegram.proposal_message_forget_failed');
  }
}
