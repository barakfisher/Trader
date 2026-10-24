import type { ScanSchedule } from '@traders/shared';

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
  /** When scheduled scans run (0060, D195): hours between market-hours scans, or null; and the two edges. */
  scan_every_hours: number | null;
  scan_pre_open: boolean;
  scan_post_close: boolean;
  /** Trades one scan may decide (0061, D197). */
  max_decisions: number;
  /** The scan running now, if any (`agent_scans_one_running` allows one); null when none. */
  running_scan: { trigger: 'manual' | 'schedule' | 'refresh'; started_at: string } | null;
  /** Spent on scans and instruction checks since midnight UTC, as text - the sum `scan_budget.py` checks. */
  llm_spent_today_micro_usd: string;
  /** This agent's average over its last scans (D46); null before its first. */
  agent_scan_cost_micro_usd: string | null;
  /** The user's agents' average over their last scans; null before any. */
  installation_scan_cost_micro_usd: string | null;
  // The mandate (0057): null or empty is no limit.
  risk_level: number | null;
  horizon: string | null;
  thesis_style: string | null;
  max_position_bps: number | null;
  cash_buffer_bps: number | null;
  max_holdings: number | null;
  allow_etfs: boolean;
  market_caps: string[];
  sectors: string[];
  industries: string[];
  etf_categories: string[];
  blocked_symbols: string[];
  /** The last contradiction check (0059, D178); null before the first. */
  instructions_check: StoredInstructionsCheck | null;
}

/** `agents.instructions_check` (0059): a result and what it judged. */
export interface StoredInstructionsCheck {
  /** Of the instructions and mandate the check read (`instructionsCheck.ts`). */
  fingerprint: string;
  conflicts: { setting: string; quote: string }[];
  checked_at: string;
  dismissed: boolean;
}

/** An agent's mandate as the database columns hold it (0057). */
export interface MandateColumns {
  risk_level: number | null;
  horizon: string | null;
  thesis_style: string | null;
  max_position_bps: number | null;
  cash_buffer_bps: number | null;
  max_holdings: number | null;
  allow_etfs: boolean;
  market_caps: string[];
  sectors: string[];
  industries: string[];
  etf_categories: string[];
  blocked_symbols: string[];
}

/** The mandate's columns, in the order every write names them. */
export const MANDATE_COLUMNS = [
  'risk_level',
  'horizon',
  'thesis_style',
  'max_position_bps',
  'cash_buffer_bps',
  'max_holdings',
  'allow_etfs',
  'market_caps',
  'sectors',
  'industries',
  'etf_categories',
  'blocked_symbols',
] as const satisfies readonly (keyof MandateColumns)[];

/**
 * The purposes an agent's daily model allowance pays for (D45, D177, D254): its scans,
 * the checks of its instructions and its research. `scan_budget.AGENT_PURPOSES_SQL` says the same.
 */
export const AGENT_SPEND_PURPOSES = "('agent_scan', 'mandate_check', 'research')";

/** Scans averaged for an estimate (D46): recent enough to follow a model change. */
export const SCAN_COST_WINDOW = 10;

const AGENT_COLUMNS = `a.id, a.slug, a.name, a.persona, a.is_primary, a.budget_minor::text AS budget_minor,
       a.currency, a.state, a.created_at,
       (SELECT count(*)::int FROM holdings h WHERE h.agent_id = a.id) AS holdings_count,
       (SELECT c.balance_minor::text FROM agent_cash c WHERE c.agent_id = a.id) AS cash_minor,
       a.llm_budget_micro_usd::text AS llm_budget_micro_usd,
       a.scan_every_hours, a.scan_pre_open, a.scan_post_close, a.max_decisions,
       (SELECT json_build_object('trigger', s.trigger, 'started_at', s.started_at)
          FROM agent_scans s WHERE s.agent_id = a.id AND s.finished_at IS NULL
       ) AS running_scan,
       (SELECT coalesce(sum(l.cost_micro_usd), 0)::text FROM llm_calls l
         WHERE l.agent_id = a.id AND l.purpose IN ${AGENT_SPEND_PURPOSES}
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
       ) AS installation_scan_cost_micro_usd,
       ${MANDATE_COLUMNS.map((column) => `a.${column}`).join(', ')}, a.instructions_check`;

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

/**
 * Simulated agents that count against the limit (D72, D199): active ones, never
 * the primary. The trigger as migration 0062 left it counts the same way.
 */
export async function countActiveAgents(userId: string): Promise<number> {
  const row = await queryOne<{ count: number }>(
    `SELECT count(*)::int AS count FROM agents a
      WHERE a.user_id = $1 AND NOT a.is_primary AND a.state = 'active'`,
    [userId],
  );
  return row?.count ?? 0;
}

/**
 * Simulated agents that count against the fixed ceiling (D202): any not
 * archived, never the primary. Migration 0063's trigger counts the same way.
 */
export async function countLiveAgents(userId: string): Promise<number> {
  const row = await queryOne<{ count: number }>(
    `SELECT count(*)::int AS count FROM agents a
      WHERE a.user_id = $1 AND NOT a.is_primary AND a.state <> 'archived'`,
    [userId],
  );
  return row?.count ?? 0;
}

export interface AgentToCreate {
  userId: string;
  slug: string;
  name: string;
  persona: string | null;
  budgetMinor: number;
  currency: string;
  scanSchedule: ScanSchedule;
  maxDecisions: number;
  mandate: MandateColumns;
  /** D200: an agent may start paused, which the limit never refuses. */
  state: 'active' | 'paused';
}

/** A simulated agent. A primary is made only by the trigger on `users` (migration 0036). */
export async function createAgent(agent: AgentToCreate): Promise<AgentRow> {
  const { everyHours, preOpen, postClose } = agent.scanSchedule;
  const fixed = [
    agent.userId,
    agent.slug,
    agent.name,
    agent.persona,
    agent.budgetMinor,
    agent.currency,
    everyHours,
    preOpen,
    postClose,
    agent.maxDecisions,
    agent.state,
  ];
  const params = [...fixed, ...MANDATE_COLUMNS.map((column) => agent.mandate[column])];
  const row = await queryOne<{ id: string }>(
    `INSERT INTO agents (user_id, slug, name, persona, budget_minor, currency,
                         scan_every_hours, scan_pre_open, scan_post_close, max_decisions, state,
                         ${MANDATE_COLUMNS.join(', ')})
     VALUES (${params.map((_, index) => `$${index + 1}`).join(', ')})
     RETURNING id`,
    params,
  );
  return (await getAgent(agent.userId, row!.id))!;
}

export interface AgentPatch {
  name?: string;
  persona?: string | null;
  budgetMinor?: number;
  state?: AgentState;
  llmBudgetMicroUsd?: number;
  scanSchedule?: ScanSchedule;
  maxDecisions?: number;
  mandate?: Partial<MandateColumns>;
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
  /** `unlessArchived`: match no archived agent, so a pause racing an archive cannot restore it (D276). */
  options: { unlessArchived?: boolean } = {},
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
  if (patch.scanSchedule !== undefined) {
    push('scan_every_hours', patch.scanSchedule.everyHours);
    push('scan_pre_open', patch.scanSchedule.preOpen);
    push('scan_post_close', patch.scanSchedule.postClose);
  }
  if (patch.maxDecisions !== undefined) push('max_decisions', patch.maxDecisions);
  for (const column of MANDATE_COLUMNS) {
    const value = patch.mandate?.[column];
    if (value !== undefined) push(column, value);
  }
  if (sets.length === 0) return getAgent(userId, agentId);
  const updated = await queryOne<{ id: string }>(
    `UPDATE agents SET ${sets.join(', ')}
      WHERE user_id = $1 AND id = $2 AND NOT is_primary${options.unlessArchived ? " AND state <> 'archived'" : ''}
      RETURNING id`,
    params,
  );
  return updated ? getAgent(userId, agentId) : null;
}

/**
 * Store a contradiction check (D178) - only while the agent still holds what was
 * judged: `fingerprint` must equal the one computed from the row just read, so a
 * save that landed during the model call is never labelled with the old answer.
 * The comparison is the caller's; this write is one statement.
 */
export async function saveInstructionsCheck(
  userId: string,
  agentId: string,
  check: StoredInstructionsCheck,
): Promise<void> {
  await query(
    `UPDATE agents SET instructions_check = $3::jsonb
      WHERE user_id = $1 AND id = $2 AND NOT is_primary`,
    [userId, agentId, JSON.stringify(check)],
  );
}

/** Dismiss the stored check, if it is still the one for `fingerprint`. */
export async function dismissInstructionsCheck(userId: string, agentId: string, fingerprint: string): Promise<void> {
  await query(
    `UPDATE agents SET instructions_check = instructions_check || '{"dismissed": true}'::jsonb
      WHERE user_id = $1 AND id = $2 AND NOT is_primary
        AND instructions_check->>'fingerprint' = $3`,
    [userId, agentId, fingerprint],
  );
}
