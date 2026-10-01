import { query, queryOne, transaction } from '../pool.js';

export interface ProposalRow {
  id: string;
  user_id: string;
  observation_id: string;
  kind: string;
  payload: unknown;
  state: string;
  expires_at: Date;
  snoozed_until: Date | null;
  decided_at: Date | null;
  decided_via: string | null;
  created_at: Date;
  /** Joined from the observation, so the inbox renders without a second query. */
  severity: string;
  subject_ref: string | null;
  headline: string;
  explanation: string | null;
  evidence: unknown;
}

export interface ProposalToCreate {
  userId: string;
  observationId: string;
  kind: string;
  payload: unknown;
  expiresAt: Date;
}

/**
 * Raise proposals for findings that do not already have one.
 *
 * `ON CONFLICT (observation_id) DO NOTHING` is what makes a re-scan cheap: the
 * observation layer already suppresses a repeated finding by `dedupe_key`, and
 * this is the same guarantee one level up, for the case where an observation
 * survives but its proposal was created by an earlier run. Two suppression
 * schemes would eventually disagree; this one defers to the first.
 *
 * The ids are returned rather than counted because a raised proposal is now the
 * start of something - a workflow run waits on it - and a caller that only
 * learns *how many* were raised cannot address any of them.
 */
export async function createProposals(proposals: ProposalToCreate[]): Promise<string[]> {
  if (proposals.length === 0) return [];

  const values: string[] = [];
  const params: unknown[] = [];
  proposals.forEach((proposal) => {
    const base = params.length;
    params.push(
      proposal.userId,
      proposal.observationId,
      proposal.kind,
      JSON.stringify(proposal.payload ?? {}),
      proposal.expiresAt,
    );
    values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::jsonb, $${base + 5})`);
  });

  const inserted = await query<{ id: string }>(
    `INSERT INTO proposals (user_id, observation_id, kind, payload, expires_at)
     VALUES ${values.join(', ')}
     ON CONFLICT (observation_id) DO NOTHING
     RETURNING id`,
    params,
  );
  return inserted.map((row) => row.id);
}

/** The columns every proposal read returns, joined to the finding behind it. */
const PROPOSAL_COLUMNS = `p.id, p.user_id, p.observation_id, p.kind, p.payload, p.state,
       p.expires_at, p.snoozed_until, p.decided_at, p.decided_via, p.created_at,
       o.severity, o.subject_ref, o.headline, o.explanation, o.evidence`;

export function findProposal(userId: string, proposalId: string): Promise<ProposalRow | null> {
  return queryOne<ProposalRow>(
    `SELECT ${PROPOSAL_COLUMNS}
       FROM proposals p
       JOIN observations o ON o.id = p.observation_id
      WHERE p.user_id = $1 AND p.id = $2`,
    [userId, proposalId],
  );
}

/**
 * The inbox. Ordered by deadline rather than by creation: what matters about an
 * open question is how long is left to answer it, and a proposal raised an hour
 * ago with a two-hour TTL is more urgent than one raised yesterday with a week.
 *
 * `open` selects on the *stored* state, and the caller re-reads each row through
 * `effectiveState` - so a proposal whose deadline passed since the last sweep
 * arrives here and is rendered as expired rather than being invisible until the
 * sweep catches up. Filtering on the computed state in SQL would duplicate the
 * state machine in a second language.
 */
export function listProposals(
  userId: string,
  options: { open?: boolean; approved?: boolean; decided?: boolean; limit?: number } = {},
): Promise<ProposalRow[]> {
  const { open = false, approved = false, decided = false, limit = 50 } = options;
  // Approvals are listed newest decision first - they are what the web inbox
  // offers Undo on, and the one just made is the one most likely to be undone.
  // Approved is terminal, so the stored state is the effective one and no
  // deadline re-check is needed.
  // `decided` is the inbox's history: every terminal state, including the ones
  // nobody chose - an expiry is an outcome the user should be able to find.
  const filter = open
    ? `AND p.state IN ('pending','snoozed')`
    : approved
      ? `AND p.state = 'approved'`
      : decided
        ? `AND p.state IN ('approved','rejected','expired')`
        : '';
  const order = approved || decided
    ? 'p.decided_at DESC NULLS LAST, p.created_at DESC'
    : 'p.expires_at ASC, p.created_at DESC';
  return query<ProposalRow>(
    `SELECT ${PROPOSAL_COLUMNS}
       FROM proposals p
       JOIN observations o ON o.id = p.observation_id
      WHERE p.user_id = $1
        ${filter}
      ORDER BY ${order}
      LIMIT $2`,
    [userId, limit],
  );
}

/** Proposals whose deadline has passed but whose row has not caught up yet. */
export function listProposalsToExpire(limit = 500): Promise<ProposalRow[]> {
  return query<ProposalRow>(
    `SELECT ${PROPOSAL_COLUMNS}
       FROM proposals p
       JOIN observations o ON o.id = p.observation_id
      WHERE p.state IN ('pending','snoozed')
        AND p.expires_at <= now()
      ORDER BY p.expires_at ASC
      LIMIT $1`,
    [limit],
  );
}

/**
 * Workflow runs still waiting on a proposal that is already decided (task 14).
 *
 * The run id is the observation id. A run is left like this when a resume
 * failed and `decideProposal` fell back to writing the decision directly: the
 * answer landed, and nothing told the waiting run. Bounded, because the sweep
 * closes them one resume at a time.
 */
export async function listLeftoverLifecycles(limit = 50): Promise<string[]> {
  const rows = await query<{ run_id: string }>(
    `SELECT s.run_id
       FROM mastra.mastra_workflow_snapshot s
       JOIN proposals p ON s.run_id = p.observation_id::text
      WHERE s.workflow_name = 'proposalLifecycle'
        AND s.snapshot->>'status' = 'suspended'
        AND p.state IN ('approved', 'rejected', 'expired')
      ORDER BY p.decided_at NULLS LAST
      LIMIT $1`,
    [limit],
  );
  return rows.map((row) => row.run_id);
}

export interface TransitionToApply {
  proposalId: string;
  userId: string;
  fromState: string;
  toState: string;
  surface: string;
  /** Null for a system transition: nobody did it, and that is not a user id. */
  actorUserId: string | null;
  snoozedUntil: Date | null;
  evidenceSnapshot: unknown;
  /** A Telegram callback nonce. Unique where present, so a replay cannot repeat. */
  idempotencyKey: string | null;
  /** The ledger row an approval writes. Null for every other transition. */
  intent: { kind: string; payload: unknown } | null;
  /** True when this transition leaves `approved`: the live ledger row is revoked. */
  revokeIntent: boolean;
}

export interface TransitionResult {
  /** False when another writer got there first; the caller re-reads and reports. */
  applied: boolean;
  intentId: string | null;
}

/**
 * Apply one transition: the row, its audit entry and - for an approval - the
 * ledger, in a single transaction.
 *
 * The UPDATE carries `AND state = $fromState` because the state machine decided
 * against a row that was read earlier, and between the read and the write
 * another surface may have answered the same proposal. Losing that race must
 * not produce an audit row for a transition that did not happen, so the
 * transaction rolls back and the caller re-reads: a Telegram tap and a click in
 * the UI a second apart end with one decision and one ledger row, not two.
 *
 * Guideline 2 lives here. An approval writes `intents` and nothing else - there
 * is no broker call to disable, because there is no broker client in the
 * repository. An undo revokes that row in the same transaction, so the ledger
 * and the proposal can never disagree about whether assent stands.
 */
export function applyProposalTransition(transition: TransitionToApply): Promise<TransitionResult> {
  return transaction(async (client) => {
    const updated = await client.query(
      `UPDATE proposals
          SET state = $1,
              snoozed_until = $2,
              decided_at = now(),
              decided_via = $3,
              updated_at = now()
        WHERE id = $4
          AND user_id = $5
          AND state = $6
        RETURNING id`,
      [
        transition.toState,
        transition.snoozedUntil,
        transition.surface,
        transition.proposalId,
        transition.userId,
        transition.fromState,
      ],
    );
    if (updated.rowCount === 0) return { applied: false, intentId: null };

    await client.query(
      `INSERT INTO proposal_transitions
         (proposal_id, user_id, from_state, to_state, surface, actor_user_id,
          evidence_snapshot, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [
        transition.proposalId,
        transition.userId,
        transition.fromState,
        transition.toState,
        transition.surface,
        transition.actorUserId,
        JSON.stringify(transition.evidenceSnapshot ?? {}),
        transition.idempotencyKey,
      ],
    );

    if (transition.revokeIntent) {
      // Marked, never deleted - see migration 0014. The partial unique index
      // allows one *live* intent per proposal, so revoking this one is what
      // lets a later re-approval write its own row.
      await client.query(
        `UPDATE intents
            SET revoked_at = now(), revoked_via = $3
          WHERE proposal_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
        [transition.proposalId, transition.userId, transition.surface],
      );
    }

    let intentId: string | null = null;
    if (transition.intent !== null) {
      const intent = await client.query<{ id: string }>(
        `INSERT INTO intents (user_id, proposal_id, kind, payload)
         VALUES ($1, $2, $3, $4::jsonb)
         RETURNING id`,
        [
          transition.userId,
          transition.proposalId,
          transition.intent.kind,
          JSON.stringify(transition.intent.payload ?? {}),
        ],
      );
      intentId = intent.rows[0]?.id ?? null;
    }

    return { applied: true, intentId };
  });
}

export interface TransitionRow {
  id: string;
  from_state: string;
  to_state: string;
  surface: string;
  actor_user_id: string | null;
  created_at: Date;
}

/** The audit trail for one proposal, newest first. */
export function listProposalTransitions(
  userId: string,
  proposalId: string,
): Promise<TransitionRow[]> {
  return query<TransitionRow>(
    `SELECT id, from_state, to_state, surface, actor_user_id, created_at
       FROM proposal_transitions
      WHERE user_id = $1 AND proposal_id = $2
      ORDER BY created_at DESC`,
    [userId, proposalId],
  );
}
