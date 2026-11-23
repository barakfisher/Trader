/**
 * The Telegram messages that show a proposal's buttons (migration 0091, D427),
 * so a change made elsewhere - the open filling an approval - can redraw them.
 *
 * Ids cross as strings: Telegram's are 64-bit, stored `bigint`, and never a
 * `Number` on the way out (as `telegram.ts` does for chats).
 */

import { query } from '../pool.js';

export interface TelegramProposalMessageRow {
  chat_id: string;
  message_id: string;
  back_to_pending: boolean;
}

/**
 * Remember a message that shows the proposal. One message shows one proposal at
 * a time: remembering it again moves its row to this proposal (a `/pending`
 * message reused for another), and only within the same account.
 */
export async function rememberTelegramProposalMessage(
  userId: string,
  proposalId: string,
  chatId: string,
  messageId: number,
  backToPending: boolean,
): Promise<void> {
  await query(
    `-- agent-blind: addressed by the proposal's own id.
     INSERT INTO telegram_proposal_messages (user_id, proposal_id, chat_id, message_id, back_to_pending)
     SELECT $1, p.id, $3::bigint, $4::bigint, $5
       FROM proposals p
      WHERE p.user_id = $1 AND p.id = $2
     ON CONFLICT (chat_id, message_id) DO UPDATE
        SET proposal_id = EXCLUDED.proposal_id,
            back_to_pending = EXCLUDED.back_to_pending
      WHERE telegram_proposal_messages.user_id = EXCLUDED.user_id`,
    [userId, proposalId, chatId, messageId, backToPending],
  );
}

/**
 * Every message remembered for one proposal, oldest first: a chat's message ids
 * only rise. Only in the chat the account is bound to now, and only while the
 * account is active, as a push is (`findTelegramPushChat`): a chat unbound by
 * `/stop`, a password reset (D313) or a rebind is never edited again.
 */
export function listTelegramProposalMessages(userId: string, proposalId: string): Promise<TelegramProposalMessageRow[]> {
  return query<TelegramProposalMessageRow>(
    `-- agent-blind: addressed by the proposal's own id.
     SELECT m.chat_id::text AS chat_id, m.message_id::text AS message_id, m.back_to_pending
       FROM telegram_proposal_messages m
       JOIN telegram_bindings b ON b.user_id = m.user_id AND b.chat_id = m.chat_id
       JOIN users u ON u.id = m.user_id AND u.status = 'active' AND NOT u.password_must_change
      WHERE m.user_id = $1 AND m.proposal_id = $2
      -- The columns, not the text aliases: "120" sorts before "99".
      ORDER BY m.chat_id, m.message_id`,
    [userId, proposalId],
  );
}

/** The message now shows something else (the `/pending` menu moved it): forget it. */
export async function forgetTelegramMessage(chatId: string, messageId: number): Promise<void> {
  await query(
    `-- agent-blind: addressed by the message's own id.
     DELETE FROM telegram_proposal_messages WHERE chat_id = $1::bigint AND message_id = $2::bigint`,
    [chatId, messageId],
  );
}
