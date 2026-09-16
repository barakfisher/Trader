/**
 * The proposal state machine (FLOWS.md F3).
 *
 * `now` is an argument to every function under test, so none of these tests
 * wait, mock a timer, or depend on how long the suite takes to run. The
 * behaviour being pinned is the invariants F3 states outright: transitions are
 * idempotent, an expired proposal can never be approved, and a decision already
 * taken cannot be overwritten.
 */

import { describe, expect, it } from 'vitest';

import {
  decide,
  effectiveState,
  isOpen,
  isTerminal,
  sweepTransition,
  type ProposalFacts,
  type ProposalState,
} from '../src/services/proposalState.js';

const NOW = new Date('2026-09-16T12:00:00.000Z');

/** Minutes either side of NOW, so no test spells out a second date literal. */
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

function facts(overrides: Partial<ProposalFacts> = {}): ProposalFacts {
  return { state: 'pending', expiresAt: at(60), snoozedUntil: null, ...overrides };
}

describe('effectiveState', () => {
  it('reads a live pending proposal as pending', () => {
    expect(effectiveState(facts(), NOW)).toBe('pending');
  });

  it('reads a passed deadline as expired before any sweep has run', () => {
    // The point of computing rather than storing: there is a window between the
    // deadline and the sweep, and it must not be a window in which the proposal
    // is still answerable.
    expect(effectiveState(facts({ expiresAt: at(-1) }), NOW)).toBe('expired');
  });

  it('treats the deadline itself as passed', () => {
    // expires_at is the first instant at which the proposal is dead, not the
    // last at which it lives. Either reading is defensible; only one can be
    // implemented, so it is pinned.
    expect(effectiveState(facts({ expiresAt: NOW }), NOW)).toBe('expired');
  });

  it('wakes an elapsed snooze into pending without anything having written to it', () => {
    const woken = facts({ state: 'snoozed', snoozedUntil: at(-5) });
    expect(effectiveState(woken, NOW)).toBe('pending');
  });

  it('keeps a snooze that has not elapsed', () => {
    expect(effectiveState(facts({ state: 'snoozed', snoozedUntil: at(5) }), NOW)).toBe('snoozed');
  });

  it('expires a snooze whose deadline passed while it slept', () => {
    // F3's `snoozed --> expired` edge. Expiry is checked before the wake-up, so
    // this reads as expired rather than as newly answerable - the other order
    // would offer a live button on a dead question.
    const slept = facts({ state: 'snoozed', snoozedUntil: at(5), expiresAt: at(-1) });
    expect(effectiveState(slept, NOW)).toBe('expired');
  });

  it('reads a snooze with no wake time as awake rather than as asleep forever', () => {
    const malformed = facts({ state: 'snoozed', snoozedUntil: null });
    expect(effectiveState(malformed, NOW)).toBe('pending');
  });

  it.each(['approved', 'rejected', 'expired'] as ProposalState[])(
    'never moves out of %s, even once the deadline passes',
    (state) => {
      expect(effectiveState(facts({ state, expiresAt: at(-1) }), NOW)).toBe(state);
    },
  );
});

describe('decide', () => {
  it('approves a pending proposal', () => {
    const decision = decide(facts(), { action: 'approve' }, NOW);
    expect(decision).toEqual({
      outcome: 'applied',
      from: 'pending',
      to: 'approved',
      snoozedUntil: null,
    });
  });

  it('approves a snoozed proposal without making the user wait for the wake-up', () => {
    // Snoozing is "not now", not "not until I say so": the Approve button in the
    // UI stays live, and it applies from the snoozed state directly.
    const decision = decide(facts({ state: 'snoozed', snoozedUntil: at(5) }), { action: 'approve' }, NOW);
    expect(decision).toMatchObject({ outcome: 'applied', from: 'snoozed', to: 'approved' });
  });

  it('reports a repeated approval as unchanged rather than as an error', () => {
    // F3: "a second tap on the same button returns the current state, never
    // re-applies". A lost network reply is the common cause, and the user who
    // retries has done nothing wrong.
    const decision = decide(facts({ state: 'approved' }), { action: 'approve' }, NOW);
    expect(decision).toEqual({ outcome: 'unchanged', state: 'approved' });
  });

  it('reports a repeated rejection as unchanged', () => {
    expect(decide(facts({ state: 'rejected' }), { action: 'reject' }, NOW)).toEqual({
      outcome: 'unchanged',
      state: 'rejected',
    });
  });

  it('refuses to reverse a decision already taken', () => {
    // The approval has already written a ledger row, and a ledger row cannot be
    // unwritten. A decision that can be overwritten is not an audit trail.
    expect(decide(facts({ state: 'approved' }), { action: 'reject' }, NOW)).toEqual({
      outcome: 'refused',
      reason: 'already_decided',
      state: 'approved',
    });
  });

  it('refuses to approve an expired proposal', () => {
    // The invariant this whole module exists for.
    expect(decide(facts({ expiresAt: at(-1) }), { action: 'approve' }, NOW)).toEqual({
      outcome: 'refused',
      reason: 'expired',
      state: 'expired',
    });
  });

  it('refuses to approve a proposal whose deadline passed while it was snoozed', () => {
    const slept = facts({ state: 'snoozed', snoozedUntil: at(5), expiresAt: at(-1) });
    expect(decide(slept, { action: 'approve' }, NOW)).toMatchObject({
      outcome: 'refused',
      reason: 'expired',
    });
  });

  it.each(['approve', 'reject', 'snooze'] as const)(
    'refuses %s on an expired proposal with the expiry reason, not a staleness one',
    (action) => {
      const decision = decide(facts({ expiresAt: at(-1) }), { action, snoozeUntil: at(-30) }, NOW);
      // The distinction the surfaces render: "this has expired, here is the
      // refreshed view" rather than "you already did this".
      expect(decision).toMatchObject({ outcome: 'refused', reason: 'expired' });
    },
  );

  it('snoozes until a time inside the deadline', () => {
    const decision = decide(facts(), { action: 'snooze', snoozeUntil: at(30) }, NOW);
    expect(decision).toEqual({
      outcome: 'applied',
      from: 'pending',
      to: 'snoozed',
      snoozedUntil: at(30),
    });
  });

  it('refuses a snooze past the deadline instead of letting the database refuse it', () => {
    // proposals_snooze_within_ttl says the same thing; saying it here turns a
    // constraint violation into an answer the client can act on.
    expect(decide(facts(), { action: 'snooze', snoozeUntil: at(90) }, NOW)).toEqual({
      outcome: 'refused',
      reason: 'snooze_past_expiry',
      state: 'pending',
    });
  });

  it('refuses a snooze into the past, which would leave a row that says asleep and reads awake', () => {
    expect(decide(facts(), { action: 'snooze', snoozeUntil: at(-1) }, NOW)).toMatchObject({
      outcome: 'refused',
      reason: 'snooze_in_the_past',
    });
  });

  it('refuses a snooze with no wake time at all', () => {
    expect(decide(facts(), { action: 'snooze' }, NOW)).toMatchObject({
      outcome: 'refused',
      reason: 'snooze_in_the_past',
    });
  });

  it('allows a snooze to be extended while it is still asleep', () => {
    const asleep = facts({ state: 'snoozed', snoozedUntil: at(5) });
    expect(decide(asleep, { action: 'snooze', snoozeUntil: at(30) }, NOW)).toMatchObject({
      outcome: 'applied',
      from: 'snoozed',
      to: 'snoozed',
      snoozedUntil: at(30),
    });
  });
});

describe('sweepTransition', () => {
  it('expires a proposal whose deadline has passed', () => {
    expect(sweepTransition(facts({ expiresAt: at(-1) }), NOW)).toBe('expired');
  });

  it('writes nothing for a proposal already marked expired', () => {
    // Otherwise every sweep appends another audit row to every dead proposal.
    expect(sweepTransition(facts({ state: 'expired', expiresAt: at(-1) }), NOW)).toBeNull();
  });

  it('writes nothing for a snooze that has merely elapsed', () => {
    // effectiveState already reads it as pending. An audit entry saying "the
    // clock advanced" is noise in a log whose purpose is recording human acts.
    expect(sweepTransition(facts({ state: 'snoozed', snoozedUntil: at(-5) }), NOW)).toBeNull();
  });

  it('writes nothing for a live proposal', () => {
    expect(sweepTransition(facts(), NOW)).toBeNull();
  });
});

describe('state predicates', () => {
  it.each(['approved', 'rejected', 'expired'] as ProposalState[])('treats %s as terminal', (s) => {
    expect(isTerminal(s)).toBe(true);
    expect(isOpen(s)).toBe(false);
  });

  it.each(['pending', 'snoozed'] as ProposalState[])('treats %s as open', (s) => {
    expect(isOpen(s)).toBe(true);
    expect(isTerminal(s)).toBe(false);
  });
});
