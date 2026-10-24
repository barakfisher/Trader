import { RESEARCH_ABANDONED_AFTER_MINUTES } from '@traders/shared';

import { query, queryOne } from '../pool.js';

/**
 * Research on the main portfolio (D254, migration 0070): the agent a user
 * assigned to it, its runs and its ratings. The AI service writes the runs and
 * the ratings; the orchestrator writes the assignment and reads the rest.
 */

export interface ResearchAgentRow {
  id: string;
  name: string;
  state: 'active' | 'paused' | 'archived';
}

/** The agent assigned to research the user's main portfolio, or null. */
export function getResearchAgent(userId: string): Promise<ResearchAgentRow | null> {
  return queryOne<ResearchAgentRow>(
    `SELECT a.id, a.name, a.state
       FROM user_settings s
       JOIN agents a ON a.user_id = s.user_id AND a.id = s.research_agent_id
      WHERE s.user_id = $1`,
    [userId],
  );
}

/**
 * Assign one of the user's simulated agents to the research, or none (D289).
 * Never the main portfolio, which researches nothing of its own (D1), nor an
 * archived agent; false when the user has no such agent.
 */
export async function setResearchAgent(userId: string, agentId: string | null): Promise<boolean> {
  if (agentId !== null) {
    const agent = await queryOne<{ id: string }>(
      `SELECT id FROM agents WHERE user_id = $1 AND id = $2 AND NOT is_primary AND state <> 'archived'`,
      [userId, agentId],
    );
    if (agent === null) return false;
  }
  await query(
    `INSERT INTO user_settings (user_id, research_agent_id, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (user_id) DO UPDATE SET research_agent_id = EXCLUDED.research_agent_id, updated_at = now()`,
    [userId, agentId],
  );
  return true;
}

export interface ResearchRunRow {
  id: string;
  trigger: 'manual' | 'schedule';
  /** `running` only while it can still be: one older than the abandonment age reads `failed`. */
  status: 'running' | 'done' | 'failed';
  holdings: number;
  rated: number;
  error: string | null;
  started_at: Date;
  finished_at: Date | null;
}

/** The user's newest research run, whichever agent made it. */
export function getLatestResearchRun(userId: string): Promise<ResearchRunRow | null> {
  return queryOne<ResearchRunRow>(
    `SELECT id, trigger,
            CASE WHEN status = 'running' AND started_at < now() - make_interval(mins => $2)
                 THEN 'failed' ELSE status END AS status,
            holdings, rated,
            CASE WHEN status = 'running' AND started_at < now() - make_interval(mins => $2)
                 THEN 'abandoned' ELSE error END AS error,
            started_at, finished_at
       FROM research_runs
      WHERE user_id = $1
      ORDER BY started_at DESC
      LIMIT 1`,
    [userId, RESEARCH_ABANDONED_AFTER_MINUTES],
  );
}

export interface ResearchHoldingRow {
  instrument_id: string;
  symbol: string;
  name: string | null;
  rating: 'bullish' | 'bearish' | 'neutral' | null;
  rationale: string | null;
  findings: unknown;
  rated_at: Date | null;
  agent_name: string | null;
  last_status: 'rated' | 'refused' | 'failed' | null;
  last_at: Date | null;
}

/**
 * Each main-portfolio holding with the agent's latest rating of it and its
 * newest attempt of any outcome, by symbol. With no agent, every holding with
 * no rating.
 */
export function listResearchHoldings(userId: string, agentId: string | null): Promise<ResearchHoldingRow[]> {
  return query<ResearchHoldingRow>(
    `SELECT i.id AS instrument_id, i.symbol, i.name,
            rated.rating, rated.rationale, rated.findings, rated.created_at AS rated_at,
            rated.agent_name, latest.status AS last_status, latest.created_at AS last_at
       FROM holdings h
       JOIN agents p ON p.id = h.agent_id AND p.user_id = h.user_id AND p.is_primary
       JOIN instruments i ON i.id = h.instrument_id
       LEFT JOIN LATERAL (
         SELECT r.rating, r.rationale, r.findings, r.created_at, a.name AS agent_name
           FROM research_ratings r
           JOIN agents a ON a.id = r.agent_id
          WHERE r.user_id = h.user_id AND r.agent_id = $2 AND r.instrument_id = h.instrument_id
            AND r.status = 'rated'
          ORDER BY r.created_at DESC
          LIMIT 1
       ) rated ON true
       LEFT JOIN LATERAL (
         SELECT r.status, r.created_at
           FROM research_ratings r
          WHERE r.user_id = h.user_id AND r.agent_id = $2 AND r.instrument_id = h.instrument_id
          ORDER BY r.created_at DESC
          LIMIT 1
       ) latest ON true
      WHERE h.user_id = $1
      ORDER BY i.symbol`,
    [userId, agentId],
  );
}

export interface ResearchAssignmentRow {
  user_id: string;
  agent_id: string;
}

/** The users among `userIds` whose assigned agent is active: the daily plan's candidates (D290). */
export function listActiveResearchAssignments(userIds: string[]): Promise<ResearchAssignmentRow[]> {
  if (userIds.length === 0) return Promise.resolve([]);
  return query<ResearchAssignmentRow>(
    `SELECT s.user_id, a.id AS agent_id
       FROM user_settings s
       JOIN agents a ON a.user_id = s.user_id AND a.id = s.research_agent_id
      WHERE s.user_id = ANY($1::uuid[]) AND a.state = 'active' AND NOT a.is_primary
      ORDER BY s.user_id`,
    [userIds],
  );
}
