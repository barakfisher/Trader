/**
 * The proposals inbox: open questions, their history, and the decisions.
 *
 * One POST per proposal carries the action rather than a REST-ish
 * `POST /proposals/:id/approve` per verb. The actions share every check that
 * matters - the deadline, the current state, the audit row - and splitting them
 * across three handlers is three places for one of those checks to go missing.
 *
 * Every response reports the *effective* state, not the stored one, so a client
 * that polls never sees a proposal look answerable after its deadline just
 * because the sweep has not run yet.
 */

import type { Hono } from 'hono';
import { z } from 'zod';

import {
  findProposal,
  listProposalTransitions,
  listProposals,
  type ProposalRow,
} from '../../db/queries.js';
import { decideProposal } from '../../mastra/proposalLifecycle.js';
import { factsOf } from '../../services/proposals.js';
import {
  effectiveState,
  undoableUntil,
  UNDO_WINDOW_SECONDS,
  type RefusalReason,
} from '../../services/proposalState.js';
import { currentUserId, type AppEnv } from '../app.js';
import { badRequest, notFound, unprocessable } from '../errors.js';

/** A ceiling on one page of the inbox, matching the observations feed. */
const MAX_PROPOSALS = 200;

const decisionSchema = z.object({
  action: z.enum(['approve', 'reject', 'snooze', 'undo']),
  // ISO 8601 UTC, like every other timestamp crossing this wire. A duration
  // ("snooze for 4h") was the alternative and was rejected: it has to be
  // resolved against a clock, and the client's clock is not the one the
  // deadline was written against.
  snoozeUntil: z.string().datetime({ offset: true }).optional(),
});

/**
 * What a refusal means to whoever asked. The reasons are a closed set in the
 * state machine, so this mapping is exhaustive by construction rather than by a
 * default branch that would silently absorb a new one.
 */
const REFUSAL_MESSAGES: Record<RefusalReason, string> = {
  expired: 'this proposal has expired and can no longer be decided',
  already_decided: 'this proposal has already been decided; an approval can be undone, nothing else can',
  not_undoable: 'only an approval can be undone',
  undo_window_closed: `an approval can only be undone within ${UNDO_WINDOW_SECONDS} seconds`,
  snooze_past_expiry: 'a snooze cannot outlast the proposal it postpones',
  snooze_in_the_past: 'a snooze must end in the future',
};

function toWire(row: ProposalRow, now: Date) {
  return {
    id: row.id,
    observationId: row.observation_id,
    kind: row.kind,
    payload: row.payload,
    // The computed state. `storedState` is exposed alongside it rather than
    // hidden, because "pending in the database, expired in fact" is a real and
    // temporary condition, and a debugging session that cannot see it is longer
    // than one that can.
    state: effectiveState(factsOf(row), now),
    storedState: row.state,
    severity: row.severity,
    subjectRef: row.subject_ref,
    headline: row.headline,
    explanation: row.explanation,
    localized: row.localized,
    evidence: row.evidence,
    expiresAt: row.expires_at.toISOString(),
    snoozedUntil: row.snoozed_until?.toISOString() ?? null,
    decidedAt: row.decided_at?.toISOString() ?? null,
    decidedVia: row.decided_via,
    // Stated by the server rather than recomputed by the client, so the web
    // cannot offer an Undo the state machine would refuse. Null once there is
    // nothing to undo.
    undoableUntil: undoableUntil(factsOf(row))?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

export function registerProposalsRoutes(app: Hono<AppEnv>): void {
  app.get('/proposals', async (context) => {
    const filter = context.req.query('state');
    const open = filter === 'open';
    const requested = Number(context.req.query('limit') ?? '50');
    const limit =
      Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_PROPOSALS) : 50;

    const now = new Date();
    const rows = await listProposals(currentUserId(context), {
      open,
      approved: filter === 'approved',
      // `history`: approved, rejected and expired, newest decision first.
      decided: filter === 'history',
      limit,
    });
    const proposals = rows.map((row) => toWire(row, now));

    return context.json({
      proposals: open
        ? // The stored-state filter let through rows whose deadline has passed
          // since the last sweep. They are expired, so they are not open - but
          // the filtering happens here, where the state machine is, rather than
          // being re-implemented as a second `expires_at > now()` in SQL.
          proposals.filter((proposal) => proposal.state === 'pending' || proposal.state === 'snoozed')
        : proposals,
    });
  });

  app.get('/proposals/:id', async (context) => {
    const userId = currentUserId(context);
    const row = await findProposal(userId, context.req.param('id'));
    if (row === null) throw notFound('proposal not found');

    const transitions = await listProposalTransitions(userId, row.id);
    return context.json({
      proposal: toWire(row, new Date()),
      // The audit trail, which is the answer to "why does this say expired when
      // I never touched it?" and to "who approved this, and from where?".
      transitions: transitions.map((transition) => ({
        from: transition.from_state,
        to: transition.to_state,
        surface: transition.surface,
        byUser: transition.actor_user_id !== null,
        at: transition.created_at.toISOString(),
      })),
    });
  });

  app.post('/proposals/:id/decision', async (context) => {
    const parsed = decisionSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      throw badRequest('invalid_body', 'decision payload failed validation', parsed.error.issues);
    }
    const { action, snoozeUntil } = parsed.data;
    if (action === 'snooze' && snoozeUntil === undefined) {
      throw badRequest('snooze_until_required', 'a snooze must say when it ends');
    }

    /**
     * Through the workflow rather than straight to `applyDecision`: the run
     * suspended on this proposal is what wakes, and the step it wakes into is
     * what applies the transition. The route sees the same `DecisionOutcome`
     * either way, because `decideProposal` falls back to the service whenever
     * there is no run to resume - which is what keeps the engine out of the
     * critical path of a decision somebody is waiting on.
     */
    const result = await decideProposal({
      userId: currentUserId(context),
      proposalId: context.req.param('id'),
      action,
      surface: 'web',
      snoozeUntil: snoozeUntil === undefined ? undefined : new Date(snoozeUntil),
    });

    if (result.outcome === 'not_found') throw notFound('proposal not found');
    if (result.outcome === 'refused') {
      // 422 rather than 409: the request was well-formed and addressed a real
      // proposal, and what it asked for is not a thing that can be done to that
      // proposal. The body carries the current state so the client can render
      // the refreshed view F3 asks for without a second round trip.
      throw unprocessable(result.reason, REFUSAL_MESSAGES[result.reason], {
        state: result.state,
      });
    }

    return context.json({
      // 'unchanged' is a success: a second tap on the same button is not an
      // error, and reporting it as one would punish the user whose network
      // dropped the first reply.
      outcome: result.outcome,
      state: result.state,
      intentId: result.outcome === 'applied' ? result.intentId : null,
    });
  });
}

export { MAX_PROPOSALS, REFUSAL_MESSAGES };
