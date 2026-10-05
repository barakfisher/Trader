/**
 * The proposal service: raising proposals from findings, and applying
 * decisions to them.
 *
 * The database is mocked, so what is under test is the policy - which findings
 * become questions, what a decision writes, and what happens when two surfaces
 * answer at once. The state machine's own rules are covered in
 * proposalState.test.ts and are not repeated here.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/db/queries.js', () => ({
  createProposals: vi.fn(async () => []),
  findProposal: vi.fn(async () => null),
  listProposalsToExpire: vi.fn(async () => []),
  applyProposalTransition: vi.fn(async () => ({ applied: true, intentId: 'intent-1' })),
}));

vi.mock('../src/logger.js', () => ({
  logger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const queries = await import('../src/db/queries.js');
const {
  applyDecision,
  meetsSeverity,
  PRIMARY_PROPOSAL_KINDS,
  PROPOSABLE_KINDS,
  raiseProposals,
  sweepExpiredProposals,
} = await import('../src/services/proposals.js');

const USER = '00000000-0000-0000-0000-000000000001';
const NOW = new Date('2026-09-16T12:00:00.000Z');
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

const SETTINGS = { proposalSeverity: 'high', proposalTtlHours: 24 };

function finding(overrides: Record<string, unknown> = {}) {
  return {
    id: 'observation-1',
    kind: 'allocation_drift',
    severity: 'high',
    subjectRef: 'portfolio',
    evidence: { drift: '0.12' },
    ...overrides,
  };
}

function proposalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'proposal-1',
    user_id: USER,
    observation_id: 'observation-1',
    kind: 'rebalance',
    payload: { observationKind: 'allocation_drift' },
    state: 'pending',
    expires_at: at(60),
    snoozed_until: null,
    decided_at: null,
    decided_via: null,
    created_at: at(-10),
    severity: 'high',
    subject_ref: 'portfolio',
    headline: 'Allocation has drifted',
    explanation: null,
    evidence: { drift: '0.12' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(queries.createProposals).mockClear().mockResolvedValue(['proposal-1']);
  vi.mocked(queries.applyProposalTransition)
    .mockClear()
    .mockResolvedValue({ applied: true, intentId: 'intent-1' });
  vi.mocked(queries.findProposal).mockClear();
  vi.mocked(queries.listProposalsToExpire).mockClear().mockResolvedValue([]);
});

describe('meetsSeverity', () => {
  it('admits a severity at or above the floor', () => {
    expect(meetsSeverity('high', 'notable')).toBe(true);
    expect(meetsSeverity('notable', 'notable')).toBe(true);
  });

  it('rejects a severity below the floor', () => {
    expect(meetsSeverity('info', 'notable')).toBe(false);
  });

  it('rejects a severity it cannot read rather than admitting it', () => {
    // An unreadable severity must not become a question the user is asked to
    // answer. Failing closed here is the cheap direction: the finding still
    // reaches the feed, it just does not demand a decision.
    expect(meetsSeverity('catastrophic', 'info')).toBe(false);
    expect(meetsSeverity('high', 'unknown-floor')).toBe(false);
  });
});

describe('raiseProposals', () => {
  it('can only ever raise kinds the passive primary may receive (decision D1)', () => {
    // raiseProposals raises against the real portfolio, so a proposable kind
    // the primary may not receive would be refused at run time - here, at review.
    for (const kind of Object.values(PROPOSABLE_KINDS)) {
      expect(PRIMARY_PROPOSAL_KINDS.has(kind), kind).toBe(true);
    }
  });

  it('raises a proposal for an actionable finding at or above the floor', async () => {
    const result = await raiseProposals(USER, [finding()], SETTINGS, NOW);
    expect(result).toEqual({ selected: 1, created: 1, proposalIds: ['proposal-1'] });

    const [selected] = vi.mocked(queries.createProposals).mock.calls[0]!;
    expect(selected).toEqual([
      expect.objectContaining({
        userId: USER,
        observationId: 'observation-1',
        kind: 'rebalance',
        // 24 hours on from `now`, computed from the setting rather than a
        // constant, so changing the TTL changes this.
        expiresAt: new Date(NOW.getTime() + 24 * 3_600_000),
      }),
    ]);
  });

  it('ignores a finding below the severity floor', async () => {
    const result = await raiseProposals(USER, [finding({ severity: 'notable' })], SETTINGS, NOW);
    expect(result.selected).toBe(0);
  });

  it('ignores a finding whose kind implies no action', async () => {
    // A price move is something to know, not something to approve. Raising a
    // proposal for it would need us to say what to do about it, which is the
    // line guideline 2 draws - and it would train the user to dismiss
    // proposals, which makes the whole layer worthless.
    const result = await raiseProposals(
      USER,
      [finding({ kind: 'price_move', severity: 'high' })],
      SETTINGS,
      NOW,
    );
    expect(result.selected).toBe(0);
    expect(queries.createProposals).toHaveBeenCalledWith([]);
  });

  it('reports fewer created than selected when one was already raised', async () => {
    // The database suppresses by observation_id. The gap between the two counts
    // is the honest measure of how much a re-scan repeats itself.
    vi.mocked(queries.createProposals).mockResolvedValueOnce([]);
    const result = await raiseProposals(USER, [finding()], SETTINGS, NOW);
    expect(result).toEqual({ selected: 1, created: 0, proposalIds: [] });
  });
});

describe('applyDecision', () => {
  it('reports a proposal that does not exist rather than inventing one', async () => {
    vi.mocked(queries.findProposal).mockResolvedValueOnce(null);
    const result = await applyDecision(
      { userId: USER, proposalId: 'missing', action: 'approve', surface: 'web' },
      NOW,
    );
    expect(result).toEqual({ outcome: 'not_found' });
  });

  it('writes a ledger intent when a proposal is approved', async () => {
    // Guideline 2: this is the entirety of what "execution" means here.
    vi.mocked(queries.findProposal).mockResolvedValueOnce(proposalRow() as never);
    const result = await applyDecision(
      { userId: USER, proposalId: 'proposal-1', action: 'approve', surface: 'web' },
      NOW,
    );

    expect(result).toEqual({ outcome: 'applied', state: 'approved', intentId: 'intent-1' });
    const [transition] = vi.mocked(queries.applyProposalTransition).mock.calls[0]!;
    expect(transition).toMatchObject({
      fromState: 'pending',
      toState: 'approved',
      surface: 'web',
      actorUserId: USER,
      intent: { kind: 'rebalance' },
      // The evidence the decision was made against, copied at decision time.
      evidenceSnapshot: { drift: '0.12' },
    });
  });

  it('revokes the ledger intent when an approval is undone', async () => {
    vi.mocked(queries.findProposal).mockResolvedValueOnce(
      proposalRow({ state: 'approved', decided_at: at(0) }) as never,
    );
    const result = await applyDecision(
      { userId: USER, proposalId: 'proposal-1', action: 'undo', surface: 'telegram' },
      NOW,
    );

    expect(result).toMatchObject({ outcome: 'applied', state: 'pending' });
    const [transition] = vi.mocked(queries.applyProposalTransition).mock.calls[0]!;
    expect(transition).toMatchObject({
      fromState: 'approved',
      toState: 'pending',
      surface: 'telegram',
      intent: null,
      revokeIntent: true,
    });
  });

  it('reports an undo past the deadline as expired, not as open again', async () => {
    // Telling the user "open again" would hand them buttons that can only be
    // refused. The approval is still withdrawn - that write happens regardless.
    vi.mocked(queries.findProposal).mockResolvedValueOnce(
      // Approved ten seconds ago, just before a deadline that has since passed.
      proposalRow({
        state: 'approved',
        expires_at: new Date(NOW.getTime() - 5_000),
        decided_at: new Date(NOW.getTime() - 10_000),
      }) as never,
    );
    const result = await applyDecision(
      { userId: USER, proposalId: 'proposal-1', action: 'undo', surface: 'web' },
      NOW,
    );
    expect(result).toMatchObject({ outcome: 'applied', state: 'expired' });
    expect(vi.mocked(queries.applyProposalTransition).mock.calls[0]![0].revokeIntent).toBe(true);
  });

  it('revokes nothing on a transition that does not leave approved', async () => {
    vi.mocked(queries.findProposal).mockResolvedValueOnce(proposalRow() as never);
    await applyDecision(
      { userId: USER, proposalId: 'proposal-1', action: 'approve', surface: 'web' },
      NOW,
    );
    expect(vi.mocked(queries.applyProposalTransition).mock.calls[0]![0].revokeIntent).toBe(false);
  });

  it('writes no ledger intent when a proposal is rejected', async () => {
    vi.mocked(queries.findProposal).mockResolvedValueOnce(proposalRow() as never);
    await applyDecision(
      { userId: USER, proposalId: 'proposal-1', action: 'reject', surface: 'web' },
      NOW,
    );
    const [transition] = vi.mocked(queries.applyProposalTransition).mock.calls[0]!;
    expect(transition).toMatchObject({ toState: 'rejected', intent: null });
  });

  it('carries a callback nonce into the audit row so a replay cannot decide twice', async () => {
    // The uniqueness is the database's (proposal_transitions_idempotency_idx);
    // what is tested here is that the service actually hands it over. A nonce
    // dropped on this path would make a forwarded Telegram message an approval.
    vi.mocked(queries.findProposal).mockResolvedValueOnce(proposalRow() as never);
    await applyDecision(
      {
        userId: USER,
        proposalId: 'proposal-1',
        action: 'approve',
        surface: 'telegram',
        idempotencyKey: 'nonce-abc',
      },
      NOW,
    );
    const [transition] = vi.mocked(queries.applyProposalTransition).mock.calls[0]!;
    expect(transition).toMatchObject({ surface: 'telegram', idempotencyKey: 'nonce-abc' });
  });

  it('writes nothing when the proposal was already in the state asked for', async () => {
    vi.mocked(queries.findProposal).mockResolvedValueOnce(
      proposalRow({ state: 'approved' }) as never,
    );
    const result = await applyDecision(
      { userId: USER, proposalId: 'proposal-1', action: 'approve', surface: 'web' },
      NOW,
    );
    expect(result).toEqual({ outcome: 'unchanged', state: 'approved' });
    // The point: no second audit row and no second ledger entry for one act.
    expect(queries.applyProposalTransition).not.toHaveBeenCalled();
  });

  it('refuses to approve an expired proposal, and records the expiry it found', async () => {
    vi.mocked(queries.findProposal).mockResolvedValueOnce(
      proposalRow({ expires_at: at(-1) }) as never,
    );
    const result = await applyDecision(
      { userId: USER, proposalId: 'proposal-1', action: 'approve', surface: 'web' },
      NOW,
    );

    expect(result).toMatchObject({ outcome: 'refused', reason: 'expired', state: 'expired' });
    // The row still said 'pending', so the expiry is persisted here rather than
    // left for the sweep - otherwise the user who just hit the deadline sees an
    // inbox that disagrees with the refusal they were given.
    const [transition] = vi.mocked(queries.applyProposalTransition).mock.calls[0]!;
    expect(transition).toMatchObject({
      toState: 'expired',
      surface: 'system',
      // Nobody decided this; the deadline did.
      actorUserId: null,
      intent: null,
    });
  });

  it('reports the winner state when another surface decided first', async () => {
    // Telegram and the UI a second apart. The conditional UPDATE fails, and the
    // loser is told what is true rather than being given an error for a
    // decision that was, after all, made.
    vi.mocked(queries.findProposal)
      .mockResolvedValueOnce(proposalRow() as never)
      .mockResolvedValueOnce(proposalRow({ state: 'rejected' }) as never);
    vi.mocked(queries.applyProposalTransition).mockResolvedValueOnce({
      applied: false,
      intentId: null,
    });

    const result = await applyDecision(
      { userId: USER, proposalId: 'proposal-1', action: 'approve', surface: 'telegram' },
      NOW,
    );
    expect(result).toEqual({ outcome: 'unchanged', state: 'rejected' });
  });
});

describe('sweepExpiredProposals', () => {
  it('expires each proposal past its deadline exactly once', async () => {
    vi.mocked(queries.listProposalsToExpire).mockResolvedValueOnce([
      proposalRow({ id: 'a', expires_at: at(-5) }),
      proposalRow({ id: 'b', expires_at: at(-2) }),
    ] as never);

    expect(await sweepExpiredProposals(NOW)).toHaveLength(2);
    expect(queries.applyProposalTransition).toHaveBeenCalledTimes(2);
    for (const [transition] of vi.mocked(queries.applyProposalTransition).mock.calls) {
      expect(transition).toMatchObject({ toState: 'expired', surface: 'system', intent: null });
    }
  });

  it('does nothing when no deadline has passed', async () => {
    expect(await sweepExpiredProposals(NOW)).toHaveLength(0);
    expect(queries.applyProposalTransition).not.toHaveBeenCalled();
  });
});
