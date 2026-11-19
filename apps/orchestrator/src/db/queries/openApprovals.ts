/**
 * Approvals for the open (migration 0087, D398-D401): a trade proposal raised
 * while its market was closed, which the user approved to be filled when it
 * opens. The proposal stays `pending` until the fill approves it; these columns
 * say what became of the approval itself.
 *
 * Every write moves from `queued` and names it in its WHERE, so a cancel and the
 * open's fill racing for the same row end with one of them: whichever updates
 * first, the other finds nothing queued.
 */

import type { PoolClient } from 'pg';

import { query, queryOne } from '../pool.js';

export type OpenApprovalSurface = 'web' | 'telegram';

/** The states an approval leaves `queued` for (`OPEN_APPROVAL_STATES` without `queued`). */
export type SettledOpenApproval = 'filled' | 'refused' | 'cancelled' | 'expired' | 'superseded';

/**
 * Approve a trade for the open: only while it is pending, raised while the
 * market was closed, and before that open. A cancelled approval may be given
 * again; a settled one may not. True when this call queued it.
 */
export async function queueOpenApproval(
  userId: string,
  proposalId: string,
  surface: OpenApprovalSurface,
  now: Date,
): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `-- agent-blind: addressed by the proposal's own id.
     UPDATE proposals
        SET open_approval = 'queued',
            open_approval_surface = $3,
            open_approval_at = $4,
            open_approval_reason = NULL,
            updated_at = now()
      WHERE user_id = $1 AND id = $2
        AND kind IN ('buy', 'sell')
        AND state = 'pending'
        AND opens_at > $4
        AND expires_at > $4
        AND (open_approval IS NULL OR open_approval = 'cancelled')
      RETURNING id`,
    [userId, proposalId, surface, now],
  );
  return row !== null;
}

/** Take back an approval that is still waiting. True when this call cancelled it. */
export async function cancelOpenApproval(userId: string, proposalId: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `-- agent-blind: addressed by the proposal's own id.
     UPDATE proposals
        SET open_approval = 'cancelled', updated_at = now()
      WHERE user_id = $1 AND id = $2 AND open_approval = 'queued'
      RETURNING id`,
    [userId, proposalId],
  );
  return row !== null;
}

/**
 * Record what the open did with a waiting approval. False when it was no longer
 * waiting - cancelled, or settled by another tick - so the caller says nothing.
 */
export async function settleOpenApproval(
  userId: string,
  proposalId: string,
  state: Exclude<SettledOpenApproval, 'filled'>,
  reason: string | null = null,
): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `-- agent-blind: addressed by the proposal's own id.
     UPDATE proposals
        SET open_approval = $3, open_approval_reason = $4, updated_at = now()
      WHERE user_id = $1 AND id = $2 AND open_approval = 'queued'
      RETURNING id`,
    [userId, proposalId, state, reason],
  );
  return row !== null;
}

/**
 * Mark it filled inside the fill's own transaction. False when it is no longer
 * waiting: the caller rolls the fill back, so a cancel that landed first wins.
 */
export async function markOpenApprovalFilledIn(
  client: PoolClient,
  userId: string,
  proposalId: string,
): Promise<boolean> {
  const updated = await client.query(
    `-- agent-blind: addressed by the proposal's own id.
     UPDATE proposals
        SET open_approval = 'filled', updated_at = now()
      WHERE user_id = $1 AND id = $2 AND open_approval = 'queued'
      RETURNING id`,
    [userId, proposalId],
  );
  return (updated.rowCount ?? 0) > 0;
}

export interface DueOpenApproval {
  id: string;
  user_id: string;
  agent_id: string;
}

/**
 * The approvals whose open has come, oldest open first, every account's: the
 * tick is the installation's work (D401). Reads the partial index 0087 built.
 */
export function listDueOpenApprovals(now: Date, limit = 100): Promise<DueOpenApproval[]> {
  return query<DueOpenApproval>(
    `-- agent-blind: the installation's tick, every account's waiting approvals.
     SELECT id, user_id, agent_id
       FROM proposals
      WHERE open_approval = 'queued' AND opens_at <= $1
      ORDER BY opens_at, id
      LIMIT $2`,
    [now, limit],
  );
}

/** Whether any approval's open has come: the tick's question before it writes a run (D401). */
export async function hasDueOpenApprovals(now: Date): Promise<boolean> {
  const row = await queryOne<{ due: boolean }>(
    `-- agent-blind: the installation's tick, every account's waiting approvals.
     SELECT EXISTS (
       SELECT 1 FROM proposals WHERE open_approval = 'queued' AND opens_at <= $1
     ) AS due`,
    [now],
  );
  return row?.due === true;
}

/**
 * A newer proposal for the same agent and symbol replaces a waiting approval
 * (D400): the older ones are marked superseded, and their ids answered so the
 * caller can close them and say so.
 */
export function supersedeOpenApprovals(
  userId: string,
  agentId: string,
  symbol: string,
  newerProposalId: string,
): Promise<{ id: string; state: string; kind: string }[]> {
  return query<{ id: string; state: string; kind: string }>(
    `UPDATE proposals
        SET open_approval = 'superseded', updated_at = now()
      WHERE user_id = $1 AND agent_id = $2
        AND open_approval = 'queued'
        AND payload ->> 'symbol' = $3
        AND id <> $4
      RETURNING id, state, kind`,
    [userId, agentId, symbol, newerProposalId],
  );
}
