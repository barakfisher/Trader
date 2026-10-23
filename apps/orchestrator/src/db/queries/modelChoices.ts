import type { UserLlmScope } from '@traders/shared';

import { query, queryOne } from '../pool.js';

/**
 * A user's own model choice (D244, migration 0069): the model for Ask and for
 * explanations in `user_settings`, an agent's in `agents.model`, and the
 * fallbacks the AI service recorded for the Telegram notice (D285). The AI
 * service reads the choices on every call; the orchestrator writes them after
 * checking them against OpenRouter's list.
 */

/** The `user_settings` column each user-wide scope is stored in; a closed map, never spliced from input. */
const SCOPE_COLUMN: Record<UserLlmScope, 'llm_assistant_model' | 'llm_explain_model'> = {
  assistant: 'llm_assistant_model',
  explain: 'llm_explain_model',
};

/** Save (or with null, clear) the user's model for Ask or for explanations. */
export async function setUserModel(userId: string, scope: UserLlmScope, model: string | null): Promise<void> {
  const column = SCOPE_COLUMN[scope];
  await query(
    `INSERT INTO user_settings (user_id, ${column}, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (user_id) DO UPDATE SET ${column} = EXCLUDED.${column}, updated_at = now()`,
    [userId, model],
  );
}

/**
 * Save (or clear) an agent's model. Never the main portfolio, which makes no
 * model call of its own, nor an archived agent, which scans no more; false when
 * the user has no such agent.
 */
export async function setAgentModel(userId: string, agentId: string, model: string | null): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `UPDATE agents SET model = $3
      WHERE user_id = $1 AND id = $2 AND NOT is_primary AND state <> 'archived'
      RETURNING id`,
    [userId, agentId, model],
  );
  return row !== null;
}

export interface ModelFallbackRow {
  id: string;
  agent_id: string;
  /** The agent's name for the `agent` scope; the main portfolio's otherwise, and unused. */
  agent_name: string;
  scope: 'agent' | UserLlmScope;
  saved_model: string;
  effective_model: string;
}

/** The fallbacks not yet announced for this user, oldest first. */
export function listUnannouncedModelFallbacks(userId: string): Promise<ModelFallbackRow[]> {
  return query<ModelFallbackRow>(
    `SELECT f.id, f.agent_id, a.name AS agent_name, f.scope, f.saved_model, f.effective_model
       FROM model_fallbacks f
       JOIN agents a ON a.user_id = f.user_id AND a.id = f.agent_id
      WHERE f.user_id = $1 AND f.announced_at IS NULL
      ORDER BY f.created_at, f.id`,
    [userId],
  );
}

/** Mark a fallback announced: its notification row is claimed, so it is never announced twice. */
export async function markModelFallbackAnnounced(userId: string, id: string): Promise<void> {
  await query(`UPDATE model_fallbacks SET announced_at = now() WHERE user_id = $1 AND id = $2`, [userId, id]);
}
