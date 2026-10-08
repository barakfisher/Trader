import { query, queryOne } from '../pool.js';

/**
 * An agent's scans, read for the *Decisions* tab (D50). The AI service writes
 * `agent_scans` (migration 0043); this side only reads it, with the proposal a
 * `trade` scan made (`proposals.scan_id`) and the fill its approval wrote
 * (`fills.proposal_id`), so a row can link to both.
 */
export interface AgentScanRow {
  id: string;
  trigger: string;
  started_at: Date;
  finished_at: Date | null;
  outcome: string | null;
  steps: number;
  /** `bigint` as text. */
  cost_micro_usd: string;
  model: string | null;
  answer: Record<string, unknown> | null;
  error: string | null;
  proposal_id: string | null;
  proposal_state: string | null;
  proposal_expires_at: Date | null;
  proposal_snoozed_until: Date | null;
  proposal_decided_at: Date | null;
  fill_id: string | null;
}

export interface AgentScanDetailRow extends AgentScanRow {
  briefing: unknown;
  transcript: unknown[];
}

const SUMMARY_COLUMNS = `s.id, s.trigger, s.started_at, s.finished_at, s.outcome, s.steps,
       s.cost_micro_usd::text AS cost_micro_usd, s.model, s.answer, s.error,
       p.id AS proposal_id, p.state AS proposal_state, p.expires_at AS proposal_expires_at,
       p.snoozed_until AS proposal_snoozed_until, p.decided_at AS proposal_decided_at,
       (SELECT f.id FROM fills f WHERE f.agent_id = s.agent_id AND f.proposal_id = p.id LIMIT 1) AS fill_id`;

const FROM = `agent_scans s LEFT JOIN proposals p ON p.agent_id = s.agent_id AND p.scan_id = s.id`;

/** Newest first; `before` pages back by start time. */
export function listAgentScans(
  userId: string,
  agentId: string,
  options: { limit: number; before?: Date },
): Promise<AgentScanRow[]> {
  return query<AgentScanRow>(
    `SELECT ${SUMMARY_COLUMNS}
       FROM ${FROM}
      WHERE s.user_id = $1 AND s.agent_id = $2
        AND ($3::timestamptz IS NULL OR s.started_at < $3)
      ORDER BY s.started_at DESC, s.id
      LIMIT $4`,
    [userId, agentId, options.before ?? null, options.limit],
  );
}

/** One scan with its briefing and transcript, the large part the list leaves out. */
export function getAgentScan(userId: string, agentId: string, scanId: string): Promise<AgentScanDetailRow | null> {
  return queryOne<AgentScanDetailRow>(
    `SELECT ${SUMMARY_COLUMNS}, s.briefing, s.transcript
       FROM ${FROM}
      WHERE s.user_id = $1 AND s.agent_id = $2 AND s.id = $3`,
    [userId, agentId, scanId],
  );
}
