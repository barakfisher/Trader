/**
 * The proposals HTTP surface: auth gating, the decision payload, and the shape
 * of a refusal.
 *
 * The database is mocked as in the other route tests. What is pinned here is
 * what a *client* sees - that the reported state is the computed one rather
 * than the stored one, that a repeated decision is a success and not an error,
 * and that a refusal carries enough for the UI to render the refreshed view F3
 * asks for without a second round trip.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = {
  id: '00000000-0000-0000-0000-000000000001',
  email: null,
  base_currency: 'USD',
  timezone: 'Asia/Jerusalem',
};

const NOW = Date.now();
const at = (minutes: number) => new Date(NOW + minutes * 60_000);

function proposalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    user_id: USER.id,
    observation_id: '22222222-2222-2222-2222-222222222222',
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
    headline: 'Allocation has drifted 12pp from target',
    explanation: 'VOO is 12 percentage points above the target weight.',
    evidence: { drift: '0.12' },
    ...overrides,
  };
}

vi.mock('../src/db/pool.js', () => ({
  queryOne: vi.fn(async () => ({ ok: 1 })),
  query: vi.fn(async () => []),
  transaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({})),
  initPool: vi.fn(),
  getPool: vi.fn(),
  closePool: vi.fn(),
}));

vi.mock('../src/db/queries.js', () => ({
  getUser: vi.fn(async () => USER),
  listProposals: vi.fn(async () => []),
  findProposal: vi.fn(async () => null),
  listProposalTransitions: vi.fn(async () => []),
  applyProposalTransition: vi.fn(async () => ({ applied: true, intentId: 'intent-1' })),
  createProposals: vi.fn(async () => []),
  listProposalsToExpire: vi.fn(async () => []),
  transaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({})),
}));

const { loadConfig, resetConfigForTests } = await import('../src/config.js');
const { createApp } = await import('../src/http/app.js');
const { createFakeAi } = await import('./fakeAi.js');
const { UNDO_WINDOW_SECONDS } = await import('../src/services/proposalState.js');
const queries = await import('../src/db/queries.js');

const ENV = {
  APP_ENV: 'test',
  LOG_LEVEL: 'error',
  APP_PASSPHRASE: 'test-passphrase',
  SESSION_SECRET: 'test-session-secret-value',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  AI_SERVICE_URL: 'http://ai-service:8000',
  INTERNAL_API_KEY: 'internal-test-key',
  ALLOWED_ORIGINS: 'http://localhost:5173',
} as unknown as NodeJS.ProcessEnv;

const ORIGIN = { origin: 'http://localhost:5173', 'content-type': 'application/json' };

let app: ReturnType<typeof createApp>;
let cookie: string;

beforeEach(async () => {
  resetConfigForTests();
  vi.clearAllMocks();
  vi.mocked(queries.getUser).mockResolvedValue(USER as never);
  vi.mocked(queries.applyProposalTransition).mockResolvedValue({
    applied: true,
    intentId: 'intent-1',
  });
  app = createApp(loadConfig(ENV), createFakeAi());
  const login = await app.request('/auth/login', {
    method: 'POST',
    headers: ORIGIN,
    body: JSON.stringify({ passphrase: 'test-passphrase' }),
  });
  cookie = (login.headers.get('set-cookie') as string).split(';')[0]!;
});

const auth = () => ({ ...ORIGIN, cookie });

describe('the proposals inbox', () => {
  it('requires a session', async () => {
    const response = await app.request('/proposals');
    expect(response.status).toBe(401);
  });

  it('reports the computed state, not the stored one', async () => {
    // The row says pending; its deadline passed two minutes ago and the sweep
    // has not run. A client that believed the stored state would render a live
    // Approve button on a dead question.
    vi.mocked(queries.listProposals).mockResolvedValueOnce([
      proposalRow({ expires_at: at(-2) }),
    ] as never);

    const response = await app.request('/proposals', { headers: auth() });
    const body = (await response.json()) as {
      proposals: { state: string; storedState: string }[];
    };
    expect(body.proposals[0]!.state).toBe('expired');
    expect(body.proposals[0]!.storedState).toBe('pending');
  });

  it('leaves a proposal out of the open list once its deadline has passed', async () => {
    // The SQL filters on the stored state, so this row arrives here and is
    // dropped by the state machine rather than by a second expires_at clause
    // that would have to agree with it forever.
    vi.mocked(queries.listProposals).mockResolvedValueOnce([
      proposalRow({ expires_at: at(-2) }),
    ] as never);

    const response = await app.request('/proposals?state=open', { headers: auth() });
    const body = (await response.json()) as { proposals: unknown[] };
    expect(body.proposals).toHaveLength(0);
  });

  it('lists approvals, newest decision first, for the web to offer Undo on', async () => {
    vi.mocked(queries.listProposals).mockResolvedValueOnce([]);
    const response = await app.request('/proposals?state=approved', { headers: auth() });
    expect(response.status).toBe(200);
    expect(vi.mocked(queries.listProposals).mock.calls.at(-1)![1]).toMatchObject({
      approved: true,
      open: false,
    });
  });

  it('keeps a live proposal in the open list', async () => {
    vi.mocked(queries.listProposals).mockResolvedValueOnce([proposalRow()] as never);
    const response = await app.request('/proposals?state=open', { headers: auth() });
    const body = (await response.json()) as { proposals: { state: string }[] };
    expect(body.proposals).toHaveLength(1);
    expect(body.proposals[0]!.state).toBe('pending');
  });

  it('returns the audit trail alongside a single proposal', async () => {
    vi.mocked(queries.findProposal).mockResolvedValueOnce(proposalRow() as never);
    vi.mocked(queries.listProposalTransitions).mockResolvedValueOnce([
      {
        id: 't-1',
        from_state: 'pending',
        to_state: 'snoozed',
        surface: 'telegram',
        actor_user_id: USER.id,
        created_at: at(-5),
      },
    ] as never);

    const response = await app.request(`/proposals/${proposalRow().id}`, { headers: auth() });
    const body = (await response.json()) as {
      transitions: { from: string; to: string; surface: string; byUser: boolean }[];
    };
    expect(body.transitions[0]).toMatchObject({
      from: 'pending',
      to: 'snoozed',
      surface: 'telegram',
      byUser: true,
    });
  });

  it('answers 404 for a proposal belonging to somebody else', async () => {
    // findProposal is scoped by user_id, so another user's id reads as absent.
    vi.mocked(queries.findProposal).mockResolvedValueOnce(null);
    const response = await app.request(`/proposals/${proposalRow().id}`, { headers: auth() });
    expect(response.status).toBe(404);
  });
});

describe('deciding a proposal', () => {
  const decide = (body: unknown) =>
    app.request(`/proposals/${proposalRow().id}/decision`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify(body),
    });

  it('approves and reports the ledger row it wrote', async () => {
    vi.mocked(queries.findProposal).mockResolvedValueOnce(proposalRow() as never);
    const response = await decide({ action: 'approve' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      outcome: 'applied',
      state: 'approved',
      intentId: 'intent-1',
    });
  });

  it('treats a repeated approval as a success rather than an error', async () => {
    // F3's idempotency requirement, from the client's side: the user whose
    // network dropped the first reply must not be shown a failure.
    vi.mocked(queries.findProposal).mockResolvedValueOnce(
      proposalRow({ state: 'approved' }) as never,
    );
    const response = await decide({ action: 'approve' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: 'unchanged', state: 'approved' });
  });

  it('refuses an expired proposal with the state needed to refresh the view', async () => {
    vi.mocked(queries.findProposal).mockResolvedValueOnce(
      proposalRow({ expires_at: at(-1) }) as never,
    );
    const response = await decide({ action: 'approve' });
    // 422, not 409: the request was well formed and named a real proposal, and
    // what it asked for is not a thing that can be done to that proposal.
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: string; details: unknown };
    expect(body.error).toBe('expired');
    expect(body.details).toMatchObject({ state: 'expired' });
  });

  it('refuses to reverse a decision already taken', async () => {
    vi.mocked(queries.findProposal).mockResolvedValueOnce(
      proposalRow({ state: 'approved' }) as never,
    );
    const response = await decide({ action: 'reject' });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('already_decided');
  });

  it('undoes an approval', async () => {
    vi.mocked(queries.findProposal).mockResolvedValueOnce(
      proposalRow({ state: 'approved', decided_at: new Date() }) as never,
    );
    const response = await decide({ action: 'undo' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: 'applied', state: 'pending' });
  });

  it('refuses an undo after the window, saying why', async () => {
    vi.mocked(queries.findProposal).mockResolvedValueOnce(
      proposalRow({
        state: 'approved',
        decided_at: new Date(Date.now() - (UNDO_WINDOW_SECONDS + 5) * 1000),
      }) as never,
    );
    const response = await decide({ action: 'undo' });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: string }).error).toBe('undo_window_closed');
  });

  it('tells the client until when an approval can be undone', async () => {
    const decidedAt = new Date();
    vi.mocked(queries.findProposal).mockResolvedValueOnce(
      proposalRow({ state: 'approved', decided_at: decidedAt }) as never,
    );
    vi.mocked(queries.listProposalTransitions).mockResolvedValueOnce([]);
    const response = await app.request(`/proposals/${proposalRow().id}`, { headers: auth() });
    const body = (await response.json()) as { proposal: { undoableUntil: string | null } };
    expect(Date.parse(body.proposal.undoableUntil!)).toBe(
      decidedAt.getTime() + UNDO_WINDOW_SECONDS * 1000,
    );
  });

  it('refuses to undo a rejection, which recorded nothing to withdraw', async () => {
    vi.mocked(queries.findProposal).mockResolvedValueOnce(
      proposalRow({ state: 'rejected' }) as never,
    );
    const response = await decide({ action: 'undo' });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: string }).error).toBe('not_undoable');
  });

  it('rejects a snooze with no end time before it reaches the database', async () => {
    const response = await decide({ action: 'snooze' });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('snooze_until_required');
  });

  it('rejects an unknown action', async () => {
    const response = await decide({ action: 'defer' });
    expect(response.status).toBe(400);
  });

  it('rejects a snooze time that is not a timestamp', async () => {
    const response = await decide({ action: 'snooze', snoozeUntil: 'tomorrow' });
    expect(response.status).toBe(400);
  });

  it('snoozes until a time inside the deadline', async () => {
    vi.mocked(queries.findProposal).mockResolvedValueOnce(proposalRow() as never);
    const response = await decide({
      action: 'snooze',
      snoozeUntil: at(30).toISOString(),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: 'applied', state: 'snoozed' });
  });

  it('refuses a snooze that would outlast the proposal', async () => {
    vi.mocked(queries.findProposal).mockResolvedValueOnce(proposalRow() as never);
    const response = await decide({
      action: 'snooze',
      snoozeUntil: at(120).toISOString(),
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('snooze_past_expiry');
  });

  it('answers 404 rather than creating anything for an unknown proposal', async () => {
    vi.mocked(queries.findProposal).mockResolvedValueOnce(null);
    const response = await decide({ action: 'approve' });
    expect(response.status).toBe(404);
    expect(queries.applyProposalTransition).not.toHaveBeenCalled();
  });
});
