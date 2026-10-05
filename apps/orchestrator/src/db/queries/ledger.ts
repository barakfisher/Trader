/**
 * An agent's ledger: its cash, and whether it has traded (migration 0040).
 *
 * Reads only. Cash and its movements are written by the database's triggers -
 * a deposit follows `agents.budget_minor`, a trade's debit or credit follows
 * its fill - and `traders_app` holds no write privilege on either table. The
 * fill writer arrives with manual trades (Stage 3, PR 4).
 */

import { queryOne } from '../pool.js';

export interface AgentCashRow {
  balance_minor: string;
  currency: string;
  updated_at: Date;
}

/** A simulated agent's cash; null for the primary, which has none (D1). */
export async function getAgentCash(userId: string, agentId: string): Promise<AgentCashRow | null> {
  return queryOne<AgentCashRow>(
    `SELECT balance_minor::text AS balance_minor, currency, updated_at
       FROM agent_cash WHERE user_id = $1 AND agent_id = $2`,
    [userId, agentId],
  );
}

/** Whether the agent has a fill - after which its budget can rise but not fall (D22). */
export async function agentHasTraded(userId: string, agentId: string): Promise<boolean> {
  const row = await queryOne<{ traded: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM fills WHERE user_id = $1 AND agent_id = $2) AS traded`,
    [userId, agentId],
  );
  return row?.traded ?? false;
}
