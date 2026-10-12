import type { AssistantDeclineReason, AssistantOutcome } from '@traders/shared';

import { query, queryOne } from '../pool.js';

/**
 * The assistant's conversations (migration 0052), as the screens read them.
 * The AI service writes them, one question at a time; this side lists, reads
 * and deletes. Every statement is scoped by `user_id`: another user's
 * conversation is not found, exactly as a missing one is.
 */

export interface AssistantConversationRow {
  id: string;
  title: string;
  created_at: Date;
  updated_at: Date;
}

export interface AssistantMessageRow {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  outcome: AssistantOutcome | null;
  reason: AssistantDeclineReason | null;
  sources: unknown;
  suggestions: unknown;
  created_at: Date;
}

export async function listAssistantConversations(
  userId: string,
  limit: number,
): Promise<AssistantConversationRow[]> {
  return query<AssistantConversationRow>(
    `SELECT id, title, created_at, updated_at
       FROM assistant_conversations
      WHERE user_id = $1
      ORDER BY updated_at DESC
      LIMIT $2`,
    [userId, limit],
  );
}

export async function getAssistantConversation(
  userId: string,
  conversationId: string,
): Promise<AssistantConversationRow | null> {
  return queryOne<AssistantConversationRow>(
    `SELECT id, title, created_at, updated_at
       FROM assistant_conversations
      WHERE user_id = $1 AND id = $2`,
    [userId, conversationId],
  );
}

/**
 * A conversation's messages, oldest first. `tool_calls` is left out: it is the
 * review record, and the screen shows a reply's sources, not its transcript.
 */
export async function listAssistantMessages(
  userId: string,
  conversationId: string,
): Promise<AssistantMessageRow[]> {
  return query<AssistantMessageRow>(
    `SELECT id, role, content, outcome, reason, sources, suggestions, created_at
       FROM assistant_messages
      WHERE user_id = $1 AND conversation_id = $2
      ORDER BY created_at, role DESC`,
    [userId, conversationId],
  );
}

/** Deletes the conversation and, by cascade, its messages. False when there was none. */
export async function deleteAssistantConversation(userId: string, conversationId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `DELETE FROM assistant_conversations WHERE user_id = $1 AND id = $2 RETURNING id`,
    [userId, conversationId],
  );
  return rows.length > 0;
}
