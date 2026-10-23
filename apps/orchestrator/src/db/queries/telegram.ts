import { query, queryOne, transaction } from '../pool.js';

export interface TelegramBindingRow {
  user_id: string;
  chat_id: string;
  username: string | null;
  bound_at: Date;
}

/**
 * Redeem a bind token and bind the chat, or report why not - atomically.
 *
 * Both halves are one transaction because the nonce insert *is* the
 * single-use check: if it succeeds this tap is the first, and the binding
 * follows. Doing the check as a SELECT and the write afterwards leaves the
 * window two simultaneous taps both pass through, which is precisely the
 * mechanism a replayed deep link would exploit.
 *
 * `chat_id` crosses as a string because Telegram ids are 64-bit and JavaScript
 * numbers are not; `bigint` on the way in, text on the way out, and never a
 * `Number` in between.
 */
export function redeemTelegramBindToken(input: {
  nonce: string;
  userId: string;
  chatId: string;
  username: string | null;
}): Promise<{ bound: boolean; reason?: 'already_used' | 'chat_taken' }> {
  return transaction(async (client) => {
    const spent = await client.query(
      `INSERT INTO telegram_bind_tokens (nonce, user_id, chat_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (nonce) DO NOTHING
       RETURNING nonce`,
      [input.nonce, input.userId, input.chatId],
    );
    if (spent.rowCount === 0) return { bound: false, reason: 'already_used' as const };

    // Re-binding the same user to a new chat is legitimate - a new phone - so
    // the user's own row is replaced. What is refused is one chat speaking for
    // two users, which the unique on chat_id enforces and which has no sensible
    // reading at all.
    try {
      await client.query(
        `INSERT INTO telegram_bindings (user_id, chat_id, username)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE
           SET chat_id = EXCLUDED.chat_id,
               username = EXCLUDED.username,
               bound_at = now()`,
        [input.userId, input.chatId, input.username],
      );
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        return { bound: false, reason: 'chat_taken' as const };
      }
      throw error;
    }
    return { bound: true };
  });
}

/** The chat a user's alerts go to, if they have connected one. */
export function findTelegramBindingByUser(userId: string): Promise<TelegramBindingRow | null> {
  return queryOne<TelegramBindingRow>(
    `SELECT user_id, chat_id::text AS chat_id, username, bound_at
       FROM telegram_bindings WHERE user_id = $1`,
    [userId],
  );
}

/**
 * The user a chat speaks for, if any.
 *
 * The webhook's authorisation check. An unbound chat resolves to null and is
 * ignored in silence (FLOWS.md F4) - answering it would confirm the bot exists
 * to anybody who found it, and there is nothing useful to say to a stranger.
 *
 * Only an active user's chat speaks for them (D278): a disabled user is locked
 * out of the web at once (D239), and their bound chat reads as unbound - no
 * question, decision, scan or change - until they are enabled again. The
 * binding itself is kept, so enabling them needs no new link.
 */
export function findTelegramBindingByChat(chatId: string): Promise<TelegramBindingRow | null> {
  return queryOne<TelegramBindingRow>(
    `SELECT b.user_id, b.chat_id::text AS chat_id, b.username, b.bound_at
       FROM telegram_bindings b
       JOIN users u ON u.id = b.user_id AND u.status = 'active'
      WHERE b.chat_id = $1`,
    [chatId],
  );
}

/** Disconnect a chat. `/stop` - the user's own off switch. */
export async function deleteTelegramBinding(userId: string): Promise<boolean> {
  const rows = await query<{ user_id: string }>(
    `DELETE FROM telegram_bindings WHERE user_id = $1 RETURNING user_id`,
    [userId],
  );
  return rows.length > 0;
}

/** Silence pushes until a moment. `/mute` - set on the settings row. */
export async function muteUntil(userId: string, until: Date | null): Promise<void> {
  await query(
    `INSERT INTO user_settings (user_id, muted_until) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET muted_until = EXCLUDED.muted_until, updated_at = now()`,
    [userId, until],
  );
}

/**
 * The chat's conversation with the assistant, while it is still the same sitting
 * (D222): the one the binding names, if it is this user's and was last touched
 * within `quietHours`. Null starts a new one. A conversation deleted on the Ask
 * page has already set the column to null (`0067`).
 */
export async function findTelegramConversation(userId: string, quietHours: number): Promise<string | null> {
  const row = await queryOne<{ id: string }>(
    `SELECT c.id
       FROM telegram_bindings b
       JOIN assistant_conversations c
         ON c.id = b.assistant_conversation_id AND c.user_id = b.user_id
      WHERE b.user_id = $1
        AND c.updated_at > now() - make_interval(hours => $2)`,
    [userId, quietHours],
  );
  return row?.id ?? null;
}

/** Point the chat at a conversation, or at none: `/new`, and every answered question. */
export async function setTelegramConversation(userId: string, conversationId: string | null): Promise<void> {
  await query(`UPDATE telegram_bindings SET assistant_conversation_id = $2 WHERE user_id = $1`, [
    userId,
    conversationId,
  ]);
}
