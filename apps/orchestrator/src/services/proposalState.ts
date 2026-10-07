/**
 * The proposal state machine of FLOWS.md F3, as pure functions.
 *
 * Nothing here touches the database, HTTP or the clock-as-ambient-fact: `now`
 * is an argument. That is what makes "an expired proposal can never be
 * approved" testable without a Postgres, and it is why the rules live in their
 * own module rather than inside the route that happens to call them first. Two
 * surfaces apply these transitions - the web UI and a Telegram callback - and a
 * state machine implemented twice is a state machine that disagrees with itself.
 *
 * **Idempotency is a return value, not an exception.** F3 requires that a second
 * tap on the same button returns the current state rather than re-applying or
 * failing. So `decide` answers with an outcome: `applied` for a real
 * transition, `unchanged` when the proposal is already in the state being asked
 * for, and `refused` with a reason when the transition is not legal at all.
 * Collapsing `unchanged` into `refused` would make a lost network reply look
 * like an error to the one user who did nothing wrong, and collapsing it into
 * `applied` would write a second audit row for an act that happened once.
 *
 * **Expiry is computed, not stored.** A proposal whose `expires_at` has passed
 * is expired the instant it passes, whether or not the sweep has run and
 * whether or not anybody has written 'expired' to its row. Reading the stored
 * state alone would let a proposal be approved in the window between its
 * deadline and the sweep noticing - a gap that widens to the whole sweep
 * interval whenever the process restarts, which is exactly when a user is most
 * likely to be retrying something. So every read goes through `effectiveState`,
 * and the stored value is a cache of it.
 */

/** The states a proposal row can hold. Mirrors the CHECK in migration 0006. */
export type ProposalState = 'pending' | 'approved' | 'rejected' | 'snoozed' | 'expired';

/**
 * What a user (or the system) asks for. Not the same set as the states.
 *
 * `undo` withdraws an approval: the proposal goes back to `pending` and the
 * ledger row the approval wrote is marked revoked - never deleted, because a
 * ledger that forgets what was once assented to is not a ledger.
 */
export type ProposalAction = 'approve' | 'reject' | 'snooze' | 'undo';

/** Where a decision arrived from. 'system' is the sweep, not a person. */
export type DecisionSurface = 'web' | 'telegram' | 'system';

/**
 * The terminal states: no decision leaves these. The one exception is `undo`,
 * which may take an approval back to `pending` - see `decideUndo`.
 */
const TERMINAL: ReadonlySet<ProposalState> = new Set<ProposalState>([
  'approved',
  'rejected',
  'expired',
]);

/** The states from which a user may still decide something. */
const OPEN: ReadonlySet<ProposalState> = new Set<ProposalState>(['pending', 'snoozed']);

export function isTerminal(state: ProposalState): boolean {
  return TERMINAL.has(state);
}

export function isOpen(state: ProposalState): boolean {
  return OPEN.has(state);
}

/** The proposal fields the state machine needs. A subset of the row on purpose. */
export interface ProposalFacts {
  state: ProposalState;
  expiresAt: Date;
  snoozedUntil: Date | null;
  /**
   * When the proposal last changed state. Only `undo` reads it: for an approved
   * proposal it is the moment of approval, which starts the undo window.
   */
  decidedAt?: Date | null;
}

/**
 * How long an approval can be undone, from the moment it was made.
 *
 * Undo exists to catch a mis-tap, not to reopen a decision at leisure - after
 * this, an approval is as settled as a rejection. Short enough that the
 * ledger's record of assent means something; long enough to notice a thumb that
 * landed on the wrong button. Chosen by the product owner.
 */
export const UNDO_WINDOW_SECONDS = 30;

/**
 * Until when an approval can still be undone, or null if it cannot be at all.
 *
 * Null for anything that is not an approval, and for an approval with no
 * recorded decision time: a window with no start cannot be shown to be open,
 * and failing closed is the cheap direction for a ledger.
 */
export function undoableUntil(facts: ProposalFacts): Date | null {
  if (facts.state !== 'approved' || !facts.decidedAt) return null;
  return new Date(facts.decidedAt.getTime() + UNDO_WINDOW_SECONDS * 1000);
}

/**
 * The state a proposal is *in*, as opposed to the state last written to it.
 *
 * Two clocks have run since the row was last touched. A deadline may have
 * passed, and a snooze may have elapsed - and the second resolves into the
 * first, because F3 lets a snooze wake into `expired` rather than into
 * `pending` when the proposal is no longer relevant at wake.
 *
 * Order matters here: expiry is checked before the snooze wake-up, so a
 * proposal that was snoozed until 17:00 with a deadline of 16:00 reads as
 * expired rather than as newly answerable. The other order would hand the user
 * a live-looking button on a dead question.
 */
export function effectiveState(facts: ProposalFacts, now: Date): ProposalState {
  if (isTerminal(facts.state)) return facts.state;
  if (facts.expiresAt.getTime() <= now.getTime()) return 'expired';
  if (facts.state === 'snoozed') {
    const until = facts.snoozedUntil;
    // A snoozed row with no wake time is not a thing the API can create, but it
    // is a thing a hand-edited database can hold. Treat it as awake: a snooze
    // that never ends is indistinguishable from a proposal quietly dropped.
    if (until === null || until.getTime() <= now.getTime()) return 'pending';
    return 'snoozed';
  }
  return facts.state;
}

/** Why a transition was refused. Each maps to a message a surface can show. */
export type RefusalReason =
  | 'expired'
  | 'already_decided'
  | 'not_undoable'
  | 'undo_window_closed'
  | 'snooze_past_expiry'
  | 'snooze_in_the_past'
  // A trade proposal (D47, D48): approved through a preview at the live price,
  // never by a bare approve, and never snoozed or undone.
  | 'approve_with_preview'
  | 'not_for_trades';

export type Decision =
  | { outcome: 'applied'; from: ProposalState; to: ProposalState; snoozedUntil: Date | null }
  | { outcome: 'unchanged'; state: ProposalState }
  | { outcome: 'refused'; reason: RefusalReason; state: ProposalState };

export interface DecisionRequest {
  action: ProposalAction;
  /** Required for `snooze`, ignored otherwise. */
  snoozeUntil?: Date;
}

/**
 * Apply an action to a proposal, or explain why it does not apply.
 *
 * The caller is expected to persist `applied` transitions and to write nothing
 * for the other two outcomes - but a surface that writes an audit row for an
 * `unchanged` result is wrong rather than merely wasteful, so the outcomes are
 * named to make the distinction hard to miss at the call site.
 */
export function decide(facts: ProposalFacts, request: DecisionRequest, now: Date): Decision {
  const current = effectiveState(facts, now);

  if (request.action === 'undo') return decideUndo(facts, current, now);

  if (current === 'expired') {
    // Checked before anything else and refused for every action: a deadline
    // that can be argued past on some paths is not a deadline. There is no
    // `unchanged` case here because no action asks for 'expired' - a user
    // tapping Approve on a dead question has not repeated themselves, they have
    // been beaten by the clock, and F3 wants them told exactly that ("this has
    // expired, here is the refreshed view") rather than "you already did this".
    return { outcome: 'refused', reason: 'expired', state: 'expired' };
  }

  if (isTerminal(current)) {
    // A second tap on the button that was already pressed. Not an error.
    if (
      (current === 'approved' && request.action === 'approve') ||
      (current === 'rejected' && request.action === 'reject')
    ) {
      return { outcome: 'unchanged', state: current };
    }
    // Approving something already rejected, or the reverse. Refused rather than
    // applied: a decision that can be overwritten is not an audit trail. An
    // approval is withdrawn with `undo`, which revokes its ledger row rather
    // than letting a second verb quietly overwrite the first.
    return { outcome: 'refused', reason: 'already_decided', state: current };
  }

  switch (request.action) {
    case 'approve':
      return { outcome: 'applied', from: current, to: 'approved', snoozedUntil: null };
    case 'reject':
      return { outcome: 'applied', from: current, to: 'rejected', snoozedUntil: null };
    case 'snooze': {
      const until = request.snoozeUntil;
      if (until === undefined || until.getTime() <= now.getTime()) {
        // A snooze into the past is a no-op dressed as an action; refusing it
        // keeps "snoozed" from meaning "awake" in the row.
        return { outcome: 'refused', reason: 'snooze_in_the_past', state: current };
      }
      if (until.getTime() > facts.expiresAt.getTime()) {
        // The database refuses this too (proposals_snooze_within_ttl). Saying
        // it here turns a constraint violation into an answer the client can
        // act on - offer the deadline as the latest snooze.
        return { outcome: 'refused', reason: 'snooze_past_expiry', state: current };
      }
      return { outcome: 'applied', from: current, to: 'snoozed', snoozedUntil: until };
    }
  }
}

/**
 * Withdraw an approval.
 *
 * Checked before the expiry rule on purpose. An approval is terminal, so
 * `effectiveState` never reads one as expired - and withdrawing assent must stay
 * possible after the deadline, because the deadline bounds how long the
 * *question* is open, not how long the user is bound by their answer. An undo
 * past the deadline lands on `pending`, which `effectiveState` then reads as
 * expired and the sweep records: the approval is gone, and the question does
 * not come back to life.
 *
 * Only an approval can be undone, and only within `UNDO_WINDOW_SECONDS` of it.
 * A rejection and a snooze write nothing to the
 * ledger, so there is nothing to withdraw; an open proposal answers `unchanged`,
 * which is what a second tap on Undo - or an Undo racing a web click - gets.
 */
function decideUndo(facts: ProposalFacts, current: ProposalState, now: Date): Decision {
  if (facts.state === 'approved') {
    const until = undoableUntil(facts);
    if (until === null || now.getTime() > until.getTime()) {
      return { outcome: 'refused', reason: 'undo_window_closed', state: 'approved' };
    }
    return { outcome: 'applied', from: 'approved', to: 'pending', snoozedUntil: null };
  }
  if (isOpen(current)) return { outcome: 'unchanged', state: current };
  return { outcome: 'refused', reason: 'not_undoable', state: current };
}

/**
 * The transition the expiry sweep should write for a proposal, if any.
 *
 * Separate from `decide` because the sweep is not a decision: it has no actor,
 * it asks for nothing, and it must never turn a snooze that is merely elapsed
 * into a state change nobody made. A woken snooze needs no row written at all -
 * `effectiveState` already reads it as pending, and an audit entry saying "the
 * clock advanced" is noise in a log whose purpose is recording human acts.
 */
export function sweepTransition(facts: ProposalFacts, now: Date): ProposalState | null {
  const current = effectiveState(facts, now);
  if (current === 'expired' && facts.state !== 'expired') return 'expired';
  return null;
}
