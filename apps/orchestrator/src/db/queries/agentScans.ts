import { query, queryOne } from '../pool.js';
import { SCAN_TOOL_CALLS } from './proposals.js';

/**
 * An agent's scans, read for the Scans tab (D50). The AI service writes
 * `agent_scans` (migration 0043); this side only reads it, with the proposals a
 * `trade` scan made (`proposals.scan_id`, one per trade since D197) and the fill
 * each approval wrote (`fills.proposal_id`), so a row can link to them.
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
  /** The scan's proposals, oldest first; timestamps as ISO text (they come through JSON). */
  proposals: ScanProposalRow[];
}

export interface ScanProposalRow {
  id: string;
  symbol: string | null;
  state: string;
  expires_at: string;
  snoozed_until: string | null;
  decided_at: string | null;
  fill_id: string | null;
}

export interface AgentScanDetailRow extends AgentScanRow {
  briefing: unknown;
  transcript: unknown[];
}

const SUMMARY_COLUMNS = `s.id, s.trigger, s.started_at, s.finished_at, s.outcome, s.steps,
       s.cost_micro_usd::text AS cost_micro_usd, s.model, s.answer, s.error,
       (SELECT coalesce(json_agg(json_build_object(
                 'id', p.id, 'symbol', p.payload ->> 'symbol', 'state', p.state,
                 'expires_at', p.expires_at, 'snoozed_until', p.snoozed_until,
                 'decided_at', p.decided_at,
                 'fill_id', (SELECT f.id FROM fills f
                              WHERE f.agent_id = s.agent_id AND f.proposal_id = p.id LIMIT 1))
               ORDER BY p.created_at), '[]'::json)
          FROM proposals p WHERE p.agent_id = s.agent_id AND p.scan_id = s.id) AS proposals`;

const FROM = `agent_scans s`;

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

/** A scan's tool calls in order, for the "Evidence checked" line; empty for an unknown scan. */
export async function listScanToolCalls(userId: string, agentId: string, scanId: string): Promise<unknown[]> {
  const row = await queryOne<{ calls: unknown[] | null }>(
    `SELECT ${SCAN_TOOL_CALLS} AS calls
       FROM agent_scans s
      WHERE s.user_id = $1 AND s.agent_id = $2 AND s.id = $3`,
    [userId, agentId, scanId],
  );
  return row?.calls ?? [];
}
