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
 */
export function findTelegramBindingByChat(chatId: string): Promise<TelegramBindingRow | null> {
  return queryOne<TelegramBindingRow>(
    `SELECT user_id, chat_id::text AS chat_id, username, bound_at
       FROM telegram_bindings WHERE chat_id = $1`,
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
