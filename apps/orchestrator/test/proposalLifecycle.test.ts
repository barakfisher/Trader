/**
 * The Mastra proposal-lifecycle workflow.
 *
 * The database is mocked and the state machine is not: `decide`, `applyDecision`
 * and `effectiveState` all run for real here, because the property under test is
 * that the workflow *delegates* rather than deciding anything itself. A test
 * that stubbed `applyDecision` would pass just as happily against a workflow
 * that had quietly grown its own copy of F3, which is the one failure this file
 * exists to catch.
 *
 * Storage is Mastra's in-memory store: suspension and resumption are engine
 * behaviour and need no Postgres to exercise, and a test that needed one would
 * stop being run. Every test takes a fresh observation id, because a run id is
 * an observation id and the store outlives the test that wrote to it - which is
 * the same reason the real system can restart and find its suspended runs.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const USER = '00000000-0000-0000-0000-000000000001';
const NOW = new Date('2026-09-17T12:00:00.000Z');
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

/**
 * The proposals table, as much of it as this suite needs: one row per test that
 * the transition writer actually mutates, so a re-read after a decision sees
 * what a re-read after a decision would see.
 */
let row: Record<string, unknown>;
let observationId: string;
let proposalId: string;
let nextId = 0;

vi.mock('../src/db/queries.js', () => ({
  createProposals: vi.fn(),
  findProposal: vi.fn(async () => row),
  listProposalsToExpire: vi.fn(async () => []),
  listLeftoverLifecycles: vi.fn(async () => []),
  applyProposalTransition: vi.fn(async (transition: Record<string, unknown>) => {
    if (row.state !== transition.fromState) return { applied: false, intentId: null };
    row.state = transition.toState;
    row.snoozed_until = transition.snoozedUntil ?? null;
    return { applied: true, intentId: transition.intent === null ? null : 'intent-1' };
  }),
}));

vi.mock('../src/logger.js', () => ({
  logger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const queries = await import('../src/db/queries.js');
const {
  AWAIT_DECISION_STEP,
  PROPOSAL_LIFECYCLE_ID,
  decideProposal,
  mayRaiseProposal,
  proposalLifecycle,
  startProposalLifecycle,
  sweepAndCloseLifecycles,
} = await import('../src/mastra/proposalLifecycle.js');
const { closeWorkflowRuntime, getWorkflowRuntime, initInMemoryWorkflowRuntimeForTests } =
  await import('../src/mastra/workflowRuntime.js');

const SETTINGS = { proposalSeverity: 'high', proposalTtlHours: 24 };

function finding(overrides: Record<string, unknown> = {}) {
  return {
    id: observationId,
    kind: 'allocation_drift',
    severity: 'high',
    subjectRef: 'portfolio',
    evidence: { drift: '0.12' },
    ...overrides,
  };
}

function startRuntime(): void {
  initInMemoryWorkflowRuntimeForTests({
    workflows: { [PROPOSAL_LIFECYCLE_ID]: proposalLifecycle },
  });
}

/** The status of the run this test's proposal is on, if there is one. */
async function runStatus(): Promise<string | undefined> {
  const workflow = getWorkflowRuntime()?.getWorkflow(PROPOSAL_LIFECYCLE_ID);
  const state = await workflow?.getWorkflowRunById(observationId);
  return state?.status;
}

function start() {
  return startProposalLifecycle({ userId: USER, finding: finding(), settings: SETTINGS });
}

beforeAll(startRuntime);
afterAll(closeWorkflowRuntime);

beforeEach(() => {
  nextId += 1;
  observationId = `observation-${nextId}`;
  proposalId = `proposal-${nextId}`;
  row = {
    id: proposalId,
    user_id: USER,
    observation_id: observationId,
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
  };
  vi.mocked(queries.createProposals)
    .mockClear()
    .mockImplementation(async () => [proposalId]);
  vi.mocked(queries.applyProposalTransition).mockClear();
  vi.mocked(queries.listProposalsToExpire).mockClear().mockResolvedValue([]);
});

describe('mayRaiseProposal', () => {
  it('admits only findings the service would raise', () => {
    expect(mayRaiseProposal(finding(), SETTINGS.proposalSeverity)).toBe(true);
    expect(mayRaiseProposal(finding({ severity: 'notable' }), SETTINGS.proposalSeverity)).toBe(
      false,
    );
    expect(mayRaiseProposal(finding({ kind: 'price_move' }), SETTINGS.proposalSeverity)).toBe(
      false,
    );
  });
});

describe('startProposalLifecycle', () => {
  it('raises the proposal and then waits for a human', async () => {
    const started = await start();

    expect(started.proposalId).toBe(proposalId);
    expect(await runStatus()).toBe('suspended');
  });

  it('ends without waiting when nothing was raised', async () => {
    // The observation already had a proposal, so the insert suppressed itself.
    // There is no question to hold open, and a run suspended on a proposal that
    // does not exist would wait for an answer nobody can give.
    vi.mocked(queries.createProposals).mockResolvedValueOnce([]);

    const started = await start();

    expect(started.proposalId).toBeNull();
    expect(await runStatus()).toBe('success');
  });

  it('opens one lifecycle per observation, however often the scan repeats', async () => {
    await start();
    const again = await start();

    expect(again.proposalId).toBeNull();
    expect(queries.createProposals).toHaveBeenCalledTimes(1);
    expect(await runStatus()).toBe('suspended');
  });

  it('still raises the proposal when there is no workflow engine at all', async () => {
    await closeWorkflowRuntime();
    try {
      const started = await start();

      expect(started.proposalId).toBe(proposalId);
      expect(queries.createProposals).toHaveBeenCalledTimes(1);
    } finally {
      startRuntime();
    }
  });
});

describe('decideProposal', () => {
  it('resumes the suspended run and ends it on an approval', async () => {
    await start();

    const outcome = await decideProposal({
      userId: USER,
      proposalId,
      action: 'approve',
      surface: 'web',
    }, NOW);

    expect(outcome).toEqual({ outcome: 'applied', state: 'approved', intentId: 'intent-1' });
    expect(await runStatus()).toBe('success');
    // The proof of delegation: exactly one transition, written by the service.
    expect(queries.applyProposalTransition).toHaveBeenCalledTimes(1);
  });

  it('goes back to waiting when the decision was a snooze', async () => {
    await start();

    const outcome = await decideProposal({
      userId: USER,
      proposalId,
      action: 'snooze',
      surface: 'web',
      snoozeUntil: at(30),
    }, NOW);

    expect(outcome).toMatchObject({ outcome: 'applied', state: 'snoozed' });
    // A snooze postpones the question; it does not answer it, so the run is
    // still holding it open and can be resumed again when the user comes back.
    expect(await runStatus()).toBe('suspended');
  });

  it('refuses through the state machine rather than around it', async () => {
    await start();
    row.expires_at = at(-1);

    const outcome = await decideProposal(
      { userId: USER, proposalId, action: 'approve', surface: 'web' },
      NOW,
    );

    expect(outcome).toMatchObject({ outcome: 'refused', reason: 'expired' });
    // The expiry the refusal implies is written, and the workflow has no say in
    // it: `applyDecision` did that, the same as it does without a workflow.
    expect(row.state).toBe('expired');
  });

  it('applies the decision anyway when no run is waiting on the proposal', async () => {
    // A proposal raised before this workflow existed. The engine has nothing to
    // resume, and the user's decision must still land.
    const outcome = await decideProposal({
      userId: USER,
      proposalId,
      action: 'reject',
      surface: 'web',
    }, NOW);

    expect(outcome).toMatchObject({ outcome: 'applied', state: 'rejected' });
    expect(queries.applyProposalTransition).toHaveBeenCalledTimes(1);
  });

  it('applies the decision anyway when the engine throws', async () => {
    await start();
    const workflow = getWorkflowRuntime()!.getWorkflow(PROPOSAL_LIFECYCLE_ID);
    vi.spyOn(workflow, 'createRun').mockRejectedValueOnce(new Error('storage is down'));

    const outcome = await decideProposal({
      userId: USER,
      proposalId,
      action: 'approve',
      surface: 'web',
    }, NOW);

    // A decision lost to an orchestration failure is a decision the user made
    // and the product forgot. `applyDecision` is idempotent, so falling back
    // cannot double-apply one that did get through.
    expect(outcome).toMatchObject({ outcome: 'applied', state: 'approved' });
    expect(row.state).toBe('approved');
    vi.restoreAllMocks();
  });
});

describe('sweepAndCloseLifecycles', () => {
  it('ends the run suspended on a proposal the clock has killed', async () => {
    await start();
    row.expires_at = at(-1);
    vi.mocked(queries.listProposalsToExpire).mockResolvedValueOnce([row] as never);

    const swept = await sweepAndCloseLifecycles(at(61));

    expect(swept).toEqual({ expired: 1, closed: 1 });
    expect(row.state).toBe('expired');
    expect(await runStatus()).toBe('success');
  });

  it('leaves the run of a live proposal waiting', async () => {
    await start();

    expect(await sweepAndCloseLifecycles(NOW)).toEqual({ expired: 0, closed: 0 });
    expect(await runStatus()).toBe('suspended');
  });

  it('ends the run left waiting on a proposal the fallback decided (task 14)', async () => {
    await start();
    // A resume failed and `decideProposal` wrote the decision directly: the
    // proposal is approved, and the run is still suspended on it.
    row.state = 'approved';
    row.decided_at = NOW;
    expect(await runStatus()).toBe('suspended');
    vi.mocked(queries.listLeftoverLifecycles).mockResolvedValueOnce([observationId]);

    expect(await sweepAndCloseLifecycles(NOW)).toEqual({ expired: 0, closed: 1 });
    expect(await runStatus()).toBe('success');
    // Ended by reading, not deciding: the approval is untouched.
    expect(row.state).toBe('approved');
  });

  it('never ends the run of a proposal that is still answerable, whatever the query says', async () => {
    await start();
    vi.mocked(queries.listLeftoverLifecycles).mockResolvedValueOnce([observationId]);

    expect(await sweepAndCloseLifecycles(NOW)).toEqual({ expired: 0, closed: 0 });
    expect(await runStatus()).toBe('suspended');
  });
});

describe('the step a resume addresses', () => {
  it('is the one the workflow suspends in', async () => {
    // A resume names its step with a string, and a rename that missed one of
    // the two places it appears would turn every resume into a silent no-op:
    // the proposal would still be decided by the fallback, and the run would
    // wait forever. So the id comes from one constant, and this asserts the
    // engine agrees with it.
    await start();
    const workflow = getWorkflowRuntime()!.getWorkflow(PROPOSAL_LIFECYCLE_ID);
    const state = await workflow.getWorkflowRunById(observationId);

    expect(state?.suspendedPaths).toHaveProperty(AWAIT_DECISION_STEP);
  });
});
