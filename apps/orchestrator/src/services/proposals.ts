/**
 * Proposals: raising them from findings, and applying decisions to them.
 *
 * The rules are in `proposalState.ts` and the SQL is in `db/queries.ts`; this
 * module is the seam between them, and it is deliberately the only one. Both
 * the web routes and - in the next PR - the Telegram callback handler go
 * through `applyDecision`, because F3's invariants are properties of the
 * *system*, not of a route: "an expired proposal can never be approved" is
 * false the moment one surface can reach the UPDATE without passing the check.
 *
 * **Guideline 2 is enforced here by omission.** Approving writes a row to
 * `intents` - the paper ledger - and nothing else; undoing marks that row
 * revoked. There is no broker client in
 * this repository to accidentally call, and the shape of an intent is a record
 * of what the user assented to, not an order anybody could submit.
 */

import { isTradeProposalKind } from '@traders/shared';

import {
  applyProposalTransition,
  createProposals,
  findProposal,
  listProposalsToExpire,
  type ProposalRow,
  type ProposalToCreate,
} from '../db/queries.js';
import { logger } from '../logger.js';
import {
  decide,
  effectiveState,
  sweepTransition,
  type DecisionSurface,
  type ProposalAction,
  type ProposalFacts,
  type ProposalState,
  type RefusalReason,
} from './proposalState.js';

/** Severities, weakest first. Mirrors SEVERITY_ORDER in the AI service. */
const SEVERITY_RANK: Record<string, number> = { info: 0, notable: 1, high: 2 };

/**
 * Observation kinds that can become a proposal, and what the resulting intent
 * would be a record of.
 *
 * Not every finding is a question. "NVDA fell 7.2% today" is an observation
 * about the world and there is nothing to approve; "your allocation has drifted
 * 12pp from your target" implies an action the user might assent to. Raising a
 * proposal for the first kind would train the user to dismiss proposals, which
 * is the failure mode that makes the whole human-in-the-loop layer worthless.
 *
 * This map is the whole policy, and it is deliberately short in M4: allocation
 * drift is the only finding the product can describe a remedy for without
 * giving investment advice (guideline 2). A drawdown proposal would have to say
 * what to do about the drawdown, which is exactly the line this product does
 * not cross.
 */
const PROPOSABLE_KINDS: Record<string, string> = {
  allocation_drift: 'rebalance',
};

export function isProposableKind(kind: string): boolean {
  return kind in PROPOSABLE_KINDS;
}

/**
 * The proposal kinds the real portfolio may be asked - acknowledgements, never
 * trades (decision D1, `docs/PROPOSAL-MULTI-AGENT.md` §10).
 *
 * "Main portfolio" is passive. `raiseProposals` raises against it today, so
 * every kind it can raise must be one of these, and it refuses otherwise before
 * the database's own trigger (migration 0038) has to. An allowlist, matching
 * the trigger: a new kind is refused on the real portfolio until someone argues
 * here, and in a migration, that it belongs there.
 */
export const PRIMARY_PROPOSAL_KINDS: ReadonlySet<string> = new Set(['rebalance']);

/** Raised instead of writing a proposal the primary agent may never receive. */
export class PrimaryAgentIsPassiveError extends Error {
  constructor(readonly kind: string) {
    super(`the primary agent is passive: a ${kind} proposal cannot be raised against the real portfolio`);
    this.name = 'PrimaryAgentIsPassiveError';
  }
}

/** Would this finding become a question at all? The same two predicates `raiseProposals` applies. */
export function mayRaiseProposal(finding: { kind: string; severity: string }, severityFloor: string): boolean {
  return isProposableKind(finding.kind) && meetsSeverity(finding.severity, severityFloor);
}

export function meetsSeverity(severity: string, floor: string): boolean {
  const rank = SEVERITY_RANK[severity];
  const floorRank = SEVERITY_RANK[floor];
  // An unrecognised severity is treated as not meeting any floor rather than as
  // meeting every one: a finding whose severity we cannot read must not become
  // a question the user is asked to answer.
  if (rank === undefined || floorRank === undefined) return false;
  return rank >= floorRank;
}

/** A finding, in the shape this module needs to decide whether to raise one. */
export interface FindingForProposal {
  id: string;
  kind: string;
  severity: string;
  subjectRef: string | null;
  evidence: unknown;
}

/**
 * Raise proposals for the findings that warrant one.
 *
 * Returns the number actually created, which is less than the number selected
 * whenever a previous run already raised one - see `createProposals` for why
 * that suppression defers to the observation layer's `dedupe_key` rather than
 * inventing a second identity scheme. The ids come back too, because an alert
 * puts Approve/Reject on the proposal it raised, and has to be able to name it.
 */
export async function raiseProposals(
  userId: string,
  findings: FindingForProposal[],
  settings: { proposalSeverity: string; proposalTtlHours: number },
  now: Date = new Date(),
): Promise<{ selected: number; created: number; proposalIds: string[] }> {
  const expiresAt = new Date(now.getTime() + settings.proposalTtlHours * 3_600_000);

  const selected: ProposalToCreate[] = findings
    .filter(
      (finding) =>
        isProposableKind(finding.kind) &&
        meetsSeverity(finding.severity, settings.proposalSeverity),
    )
    .map((finding) => ({
      userId,
      observationId: finding.id,
      kind: PROPOSABLE_KINDS[finding.kind]!,
      // The evidence is not copied into the payload: the proposal joins its
      // observation for display, and the snapshot that matters is the one taken
      // at decision time, which the audit row carries.
      payload: { observationKind: finding.kind, subjectRef: finding.subjectRef },
      expiresAt,
    }));

  // Every proposal raised here is the real portfolio's (Stage 1: findings come
  // from the primary's scan), so each must be a kind the primary may receive.
  const refused = selected.find((proposal) => !PRIMARY_PROPOSAL_KINDS.has(proposal.kind));
  if (refused) throw new PrimaryAgentIsPassiveError(refused.kind);

  const proposalIds = await createProposals(selected);
  return { selected: selected.length, created: proposalIds.length, proposalIds };
}

/** How a proposal reads right now, deadline and snooze taken into account. */
export function factsOf(row: ProposalRow): ProposalFacts {
  return {
    state: row.state as ProposalState,
    expiresAt: row.expires_at,
    snoozedUntil: row.snoozed_until,
    decidedAt: row.decided_at,
  };
}

export type DecisionOutcome =
  | { outcome: 'applied'; state: ProposalState; intentId: string | null }
  | { outcome: 'unchanged'; state: ProposalState }
  | { outcome: 'refused'; reason: RefusalReason; state: ProposalState }
  | { outcome: 'not_found' };

export interface DecisionInput {
  userId: string;
  proposalId: string;
  action: ProposalAction;
  surface: DecisionSurface;
  snoozeUntil?: Date;
  /** A Telegram callback nonce, so a replayed message cannot decide twice. */
  idempotencyKey?: string;
}

/**
 * Apply a user's decision to a proposal.
 *
 * The read-decide-write sequence is not atomic, and it does not need to be: the
 * UPDATE is conditional on the state that was read, so a decision that loses a
 * race changes nothing and is re-read rather than re-applied. That turns the
 * dangerous interleaving - two surfaces approving the same proposal at once -
 * into the same answer the second tap on one button gets, which is what F3 asks
 * for anyway.
 */
export async function applyDecision(
  input: DecisionInput,
  now: Date = new Date(),
): Promise<DecisionOutcome> {
  const row = await findProposal(input.userId, input.proposalId);
  if (row === null) return { outcome: 'not_found' };

  // A trade is approved through a preview at the live price and a confirm that
  // fills (`tradeApproval.ts`, D47), and is never snoozed or undone (D48). Only
  // its rejection passes through here, whatever a surface sends.
  if (isTradeProposalKind(row.kind) && input.action !== 'reject') {
    return {
      outcome: 'refused',
      reason: input.action === 'approve' ? 'approve_with_preview' : 'not_for_trades',
      state: effectiveState(factsOf(row), now),
    };
  }

  const decision = decide(
    factsOf(row),
    { action: input.action, snoozeUntil: input.snoozeUntil },
    now,
  );

  if (decision.outcome === 'unchanged') {
    return { outcome: 'unchanged', state: decision.state };
  }
  if (decision.outcome === 'refused') {
    // A refusal because the deadline passed is worth persisting: the row still
    // says pending, and leaving it that way means the next reader recomputes
    // the same expiry. The sweep would get there eventually; doing it here
    // means the user who just hit the deadline sees a consistent inbox.
    if (decision.reason === 'expired' && row.state !== 'expired') {
      await expireProposal(row, now);
    }
    return { outcome: 'refused', reason: decision.reason, state: decision.state };
  }

  const result = await applyProposalTransition({
    proposalId: row.id,
    userId: input.userId,
    fromState: row.state,
    toState: decision.to,
    surface: input.surface,
    actorUserId: input.userId,
    snoozedUntil: decision.snoozedUntil,
    // What the decision was made against, copied at decision time. This is the
    // answer to "what did I know when I approved this?", and it has to survive
    // any later rewrite of the observation.
    evidenceSnapshot: row.evidence,
    idempotencyKey: input.idempotencyKey ?? null,
    intent:
      decision.to === 'approved'
        ? { kind: row.kind, payload: row.payload }
        : null,
    // Leaving `approved` by any path withdraws the assent it recorded. The row
    // is marked, not deleted: "approved at 10:02, withdrawn at 10:05" is the
    // history, and a ledger that kept only the second half would be lying.
    revokeIntent: decision.from === 'approved',
  });

  if (!result.applied) {
    // Another surface answered between the read and the write. Re-read and
    // report what is true now, which is the same thing a repeated tap gets.
    const fresh = await findProposal(input.userId, input.proposalId);
    if (fresh === null) return { outcome: 'not_found' };
    logger().info(
      { proposalId: row.id, surface: input.surface, state: fresh.state },
      'proposal.decision_lost_race',
    );
    return { outcome: 'unchanged', state: effectiveState(factsOf(fresh), now) };
  }

  logger().info(
    {
      proposalId: row.id,
      from: decision.from,
      to: decision.to,
      surface: input.surface,
      intentId: result.intentId,
    },
    'proposal.transition',
  );
  // Reported through `effectiveState` rather than as `decision.to`, because the
  // two differ in exactly one case: an undo past the deadline writes `pending`
  // onto a question that is already dead, and telling the user "open again"
  // would hand them a button that can only be refused.
  const state = effectiveState(
    { state: decision.to, expiresAt: row.expires_at, snoozedUntil: decision.snoozedUntil },
    now,
  );
  return { outcome: 'applied', state, intentId: result.intentId };
}

/** Write the expiry the clock has already made true. */
async function expireProposal(row: ProposalRow, now: Date): Promise<void> {
  const to = sweepTransition(factsOf(row), now);
  if (to === null) return;
  await applyProposalTransition({
    proposalId: row.id,
    userId: row.user_id,
    fromState: row.state,
    toState: to,
    // Nobody decided this; the deadline did. Recording it as a user act would
    // make the audit trail claim a decision that was never taken.
    surface: 'system',
    actorUserId: null,
    snoozedUntil: null,
    evidenceSnapshot: row.evidence,
    idempotencyKey: null,
    intent: null,
    revokeIntent: false,
  });
}

/** A proposal the sweep has just expired, and the observation behind it. */
export interface ExpiredProposal {
  id: string;
  observationId: string;
}

/**
 * Expire every proposal whose deadline has passed.
 *
 * This is housekeeping, not correctness: `effectiveState` already reads a
 * passed deadline as expired, so a sweep that never ran would not let anybody
 * approve anything. What it buys is an inbox query that can filter on the
 * stored state, and an audit trail that says when each proposal died rather
 * than leaving the reader to infer it from a timestamp.
 *
 * What was expired is returned rather than counted, so a caller can say which
 * questions closed; the sweep run records the count.
 */
export async function sweepExpiredProposals(now: Date = new Date()): Promise<ExpiredProposal[]> {
  const due = await listProposalsToExpire();
  const expired: ExpiredProposal[] = [];
  for (const row of due) {
    await expireProposal(row, now);
    expired.push({ id: row.id, observationId: row.observation_id });
  }
  if (expired.length > 0) logger().info({ expired: expired.length }, 'proposal.sweep');
  return expired;
}

export { PROPOSABLE_KINDS, SEVERITY_RANK };
