import { queryOne } from '../pool.js';

/**
 * A trade proposal's re-check (D212, D213): the `refresh` scan that names it
 * (`agent_scans.refreshes_proposal_id`, migration 0066), and the proposal that
 * scan raised, if any. The AI service writes both; this side only reads them.
 */
export interface RecheckRow {
  scan_id: string;
  started_at: Date;
  finished_at: Date | null;
  outcome: string | null;
  answer: Record<string, unknown> | null;
  /** The proposal the re-check raised; null when it raised none. */
  new_proposal_id: string | null;
}

/**
 * The proposal's latest re-check. The latest is the one that matters: one that
 * reached an answer is the only one there will ever be (`agent_scans_one_refresh`),
 * so any earlier ones reached none.
 */
export function latestRecheck(userId: string, agentId: string, proposalId: string): Promise<RecheckRow | null> {
  return queryOne<RecheckRow>(
    `SELECT s.id AS scan_id, s.started_at, s.finished_at, s.outcome, s.answer,
            (SELECT p.id FROM proposals p
              WHERE p.agent_id = s.agent_id AND p.scan_id = s.id
              ORDER BY p.created_at LIMIT 1) AS new_proposal_id
       FROM agent_scans s
      WHERE s.user_id = $1 AND s.agent_id = $2 AND s.refreshes_proposal_id = $3
      ORDER BY s.started_at DESC
      LIMIT 1`,
    [userId, agentId, proposalId],
  );
}
