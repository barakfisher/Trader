import { query, queryOne } from '../pool.js';

/**
 * The agent that owns a user's real portfolio ("Main portfolio", migration 0036).
 *
 * Every portfolio row carries an `agent_id`, and in Stage 1 of the multi-agent
 * work every row a user writes is the primary's. This is how an edge - an HTTP
 * route, a run handler - learns which id that is; below the edge the id is
 * passed explicitly, never re-derived, so the day a write belongs to another
 * agent changes one call site rather than a query.
 *
 * Not cached: it is one indexed read per request or run, and a cache would
 * outlive a test database that re-creates the same user with a new primary.
 * A missing primary throws rather than returning null, because a write with no
 * owner is the one thing the column exists to prevent.
 */
export async function primaryAgentId(userId: string): Promise<string> {
  const row = await queryOne<{ id: string }>(
    'SELECT id FROM agents WHERE user_id = $1 AND is_primary',
    [userId],
  );
  if (row === null) throw new Error(`user ${userId} has no primary agent`);
  return row.id;
}

export type AgentState = 'active' | 'paused' | 'archived';

export interface AgentRow {
  id: string;
  slug: string;
  name: string;
  persona: string | null;
  is_primary: boolean;
  /** `bigint` comes back from `pg` as text; the route converts it once, checked. */
  budget_minor: string | null;
  currency: string;
  state: AgentState;
  created_at: Date;
  holdings_count: number;
  /** The agent's cash (migration 0040), as text; null for the primary, which has none. */
  cash_minor: string | null;
  /** D45: the daily model allowance, integer micro-USD as text. */
  llm_budget_micro_usd: string;
  scan_schedule: string;
  /** Spent on scans since midnight UTC, as text - the sum `scan_budget.py` checks. */
  llm_spent_today_micro_usd: string;
  /** This agent's average over its last scans (D46); null before its first. */
  agent_scan_cost_micro_usd: string | null;
  /** The user's agents' average over their last scans; null before any. */
  installation_scan_cost_micro_usd: string | null;
}

/** Scans averaged for an estimate (D46): recent enough to follow a model change. */
export const SCAN_COST_WINDOW = 10;

const AGENT_COLUMNS = `a.id, a.slug, a.name, a.persona, a.is_primary, a.budget_minor::text AS budget_minor,
       a.currency, a.state, a.created_at,
       (SELECT count(*)::int FROM holdings h WHERE h.agent_id = a.id) AS holdings_count,
       (SELECT c.balance_minor::text FROM agent_cash c WHERE c.agent_id = a.id) AS cash_minor,
       a.llm_budget_micro_usd::text AS llm_budget_micro_usd, a.scan_schedule,
       (SELECT coalesce(sum(l.cost_micro_usd), 0)::text FROM llm_calls l
         WHERE l.agent_id = a.id AND l.purpose = 'agent_scan'
           AND l.started_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
       ) AS llm_spent_today_micro_usd,
       (SELECT round(avg(r.cost_micro_usd))::text FROM (
          SELECT s.cost_micro_usd FROM agent_scans s
           WHERE s.agent_id = a.id AND s.finished_at IS NOT NULL
           ORDER BY s.started_at DESC LIMIT ${SCAN_COST_WINDOW}) r
       ) AS agent_scan_cost_micro_usd,
       (SELECT round(avg(r.cost_micro_usd))::text FROM (
          SELECT s.cost_micro_usd FROM agent_scans s
           WHERE s.user_id = a.user_id AND s.finished_at IS NOT NULL
           ORDER BY s.started_at DESC LIMIT ${SCAN_COST_WINDOW}) r
       ) AS installation_scan_cost_micro_usd`;

/** The user's agents: the primary first, then the rest oldest first. */
export function listAgents(userId: string): Promise<AgentRow[]> {
  return query<AgentRow>(
    `SELECT ${AGENT_COLUMNS}
       FROM agents a
      WHERE a.user_id = $1
      ORDER BY a.is_primary DESC, a.created_at, a.id`,
    [userId],
  );
}

export function getAgent(userId: string, agentId: string): Promise<AgentRow | null> {
  return queryOne<AgentRow>(
    `SELECT ${AGENT_COLUMNS} FROM agents a WHERE a.user_id = $1 AND a.id = $2`,
    [userId, agentId],
  );
}

export interface AgentToCreate {
  userId: string;
  slug: string;
  name: string;
  persona: string | null;
  budgetMinor: number;
  currency: string;
}

/** A simulated agent. A primary is made only by the trigger on `users` (migration 0036). */
export async function createAgent(agent: AgentToCreate): Promise<AgentRow> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO agents (user_id, slug, name, persona, budget_minor, currency)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [agent.userId, agent.slug, agent.name, agent.persona, agent.budgetMinor, agent.currency],
  );
  return (await getAgent(agent.userId, row!.id))!;
}

export interface AgentPatch {
  name?: string;
  persona?: string | null;
  budgetMinor?: number;
  state?: AgentState;
  llmBudgetMicroUsd?: number;
  scanSchedule?: string;
}

/**
 * Change a simulated agent. The primary is never matched (`NOT is_primary`):
 * it is the real portfolio and passive (decision D1), and the database's own
 * CHECK would refuse a budget, a persona or a pause on it anyway - this makes
 * the refusal a "no such agent" the route can name, rather than an error.
 */
export async function updateAgent(
  userId: string,
  agentId: string,
  patch: AgentPatch,
): Promise<AgentRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [userId, agentId];
  const push = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (patch.name !== undefined) push('name', patch.name);
  if (patch.persona !== undefined) push('persona', patch.persona);
  if (patch.budgetMinor !== undefined) push('budget_minor', patch.budgetMinor);
  if (patch.state !== undefined) push('state', patch.state);
  if (patch.llmBudgetMicroUsd !== undefined) push('llm_budget_micro_usd', patch.llmBudgetMicroUsd);
  if (patch.scanSchedule !== undefined) push('scan_schedule', patch.scanSchedule);
  if (sets.length === 0) return getAgent(userId, agentId);
  const updated = await queryOne<{ id: string }>(
    `UPDATE agents SET ${sets.join(', ')}
      WHERE user_id = $1 AND id = $2 AND NOT is_primary
      RETURNING id`,
    params,
  );
  return updated ? getAgent(userId, agentId) : null;
}
