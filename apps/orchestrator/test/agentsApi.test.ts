/**
 * The agents API (multi-agent Stage 2): what it accepts, what it refuses before
 * any SQL runs, and that the real portfolio cannot be changed through it.
 *
 * The database layer is mocked, as in settings.test.ts: every rule asserted here
 * is one this process applies itself. The SQL is exercised against Postgres in
 * queries.postgres.test.ts.
 */

import { randomUUID } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HORIZON_MAX_DECISIONS,
  HORIZON_SCHEDULES,
  MAX_AGENTS_PER_USER_CEILING,
  MAX_DECISIONS_PER_SCAN,
  MAX_SCAN_EVERY_HOURS,
  type ScanSchedule,
} from '@traders/shared';

import { ACTIVE_SESSION, sessionCookie } from './session.js';

const USER = {
  ...ACTIVE_SESSION,
  id: '00000000-0000-0000-0000-000000000001',
  email: null,
  base_currency: 'USD',
  timezone: 'Asia/Jerusalem',
};
/** The installation's agent limit in these tests' settings. */
const LIMIT = 3;
const PRIMARY = '90000000-0000-0000-0000-000000000001';
const SIMULATED = '90000000-0000-0000-0000-0000000000a1';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: SIMULATED,
    slug: 'agent-1234abcd',
    name: 'Momentum',
    persona: null,
    is_primary: false,
    budget_minor: '100000',
    currency: 'USD',
    state: 'active',
    created_at: new Date('2026-10-05T10:00:00Z'),
    holdings_count: 0,
    llm_budget_micro_usd: '500000',
    scan_every_hours: null,
    scan_pre_open: true,
    scan_post_close: false,
    max_decisions: 1,
    running_scan: null,
    llm_spent_today_micro_usd: '108022',
    agent_scan_cost_micro_usd: null,
    installation_scan_cost_micro_usd: null,
    risk_level: null,
    horizon: null,
    thesis_style: null,
    max_position_bps: null,
    cash_buffer_bps: null,
    max_holdings: null,
    allow_etfs: true,
    market_caps: [],
    sectors: [],
    industries: [],
    etf_categories: [],
    blocked_symbols: [],
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
  listTaxonomy: vi.fn(async () => [
    { kind: 'industry', name: 'Uranium', sector: 'Energy', instruments: 9, updated_at: new Date() },
    { kind: 'etf_category', name: 'Large Blend', sector: null, instruments: 207, updated_at: new Date() },
  ]),
  agentHasTraded: vi.fn(async () => false),
  getInstallationSettings: vi.fn(async () => ({ max_agents_per_user: LIMIT, updated_at: new Date() })),
  countActiveAgents: vi.fn(async () => 1),
  countLiveAgents: vi.fn(async () => 1),
  listAgents: vi.fn(async () => [
    row({ id: PRIMARY, slug: 'primary-portfolio', name: 'Main portfolio', is_primary: true, budget_minor: null }),
    row(),
  ]),
  getAgent: vi.fn(async (_userId: string, agentId: string) =>
    agentId === PRIMARY
      ? row({ id: PRIMARY, name: 'Main portfolio', is_primary: true, budget_minor: null })
      : agentId === SIMULATED
        ? row()
        : null,
  ),
  createAgent: vi.fn(async (agent: Record<string, unknown>) =>
    row({ name: agent.name, persona: agent.persona, budget_minor: String(agent.budgetMinor) }),
  ),
  updateAgent: vi.fn(async (_userId: string, _agentId: string, patch: Record<string, unknown>) =>
    row({
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.state === undefined ? {} : { state: patch.state }),
      ...(patch.budgetMinor === undefined ? {} : { budget_minor: String(patch.budgetMinor) }),
      ...(patch.llmBudgetMicroUsd === undefined ? {} : { llm_budget_micro_usd: String(patch.llmBudgetMicroUsd) }),
      ...(patch.maxDecisions === undefined ? {} : { max_decisions: patch.maxDecisions }),
      ...(patch.scanSchedule === undefined
        ? {}
        : (({ everyHours, preOpen, postClose }) => ({
            scan_every_hours: everyHours,
            scan_pre_open: preOpen,
            scan_post_close: postClose,
          }))(patch.scanSchedule as ScanSchedule)),
    }),
  ),
}));

const { loadConfig, resetConfigForTests } = await import('../src/config.js');
const { createApp } = await import('../src/http/app.js');
const { MAX_BUDGET_MINOR, MAX_PERSONA_LENGTH, MAX_LLM_BUDGET_MICRO_USD, MEASURED_SCAN_COST_MICRO_USD, scanCostOf } =
  await import('../src/http/routes/agents.js');
const { createFakeAi } = await import('./fakeAi.js');
const queries = await import('../src/db/queries.js');

const ENV = {
  APP_ENV: 'test',
  LOG_LEVEL: 'error',
  SESSION_SECRET: 'test-session-secret-value',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  AI_SERVICE_URL: 'http://ai-service:8000',
  INTERNAL_API_KEY: 'internal-test-key',
  ALLOWED_ORIGINS: 'http://localhost:5173',
} as unknown as NodeJS.ProcessEnv;

const ORIGIN = { origin: 'http://localhost:5173', 'content-type': 'application/json' };

function buildApp() {
  resetConfigForTests();
  return createApp(loadConfig(ENV), createFakeAi());
}

describe('the agents API', () => {
  let app: ReturnType<typeof buildApp>;
  let cookie: string;

  const send = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { ...ORIGIN, cookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  beforeEach(async () => {
    vi.clearAllMocks();
    app = buildApp();
    cookie = sessionCookie();
  });

  it('lists the primary first, with no budget, and the simulated agents after it', async () => {
    const response = await send('GET', '/agents');
    expect(response.status).toBe(200);
    const { agents } = await response.json();
    expect(agents.map((agent: { isPrimary: boolean }) => agent.isPrimary)).toEqual([true, false]);
    expect(agents[0]).toMatchObject({ budgetMinor: null });
    expect(agents[1]).toMatchObject({ name: 'Momentum', budgetMinor: 100000, currency: 'USD', state: 'active' });
  });

  it('creates an agent with a budget in exact cents, in USD (decision D7)', async () => {
    const response = await send('POST', '/agents', { name: ' Momentum ', budget: '1000.5', persona: 'Buys strength.' });
    expect(response.status).toBe(201);
    expect(queries.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Momentum', budgetMinor: 100050, currency: 'USD', persona: 'Buys strength.' }),
    );
    const created = vi.mocked(queries.createAgent).mock.calls[0]![0];
    expect(created.slug).toMatch(/^agent-[0-9a-f]{8}$/);
  });

  it.each([
    ['three decimals', '10.005'],
    ['a sign', '-5'],
    ['a currency symbol', '$100'],
    ['a float exponent', '1e3'],
  ])('refuses a budget with %s rather than rounding it', async (_label, budget) => {
    const response = await send('POST', '/agents', { name: 'A', budget });
    expect(response.status).toBe(400);
    expect(queries.createAgent).not.toHaveBeenCalled();
  });

  it('refuses a zero budget and one past the ceiling', async () => {
    expect((await send('POST', '/agents', { name: 'A', budget: '0' })).status).toBe(422);
    const tooMuch = String(MAX_BUDGET_MINOR / 100 + 1);
    expect((await send('POST', '/agents', { name: 'A', budget: tooMuch })).status).toBe(422);
    expect(queries.createAgent).not.toHaveBeenCalled();
  });

  it('refuses a persona longer than the limit, and stores an empty one as none', async () => {
    const long = 'x'.repeat(MAX_PERSONA_LENGTH + 1);
    expect((await send('POST', '/agents', { name: 'A', budget: '100', persona: long })).status).toBe(400);
    await send('POST', '/agents', { name: 'A', budget: '100', persona: '   ' });
    expect(queries.createAgent).toHaveBeenCalledWith(expect.objectContaining({ persona: null }));
  });

  it('answers a taken name with 409, not a database error', async () => {
    vi.mocked(queries.createAgent).mockRejectedValueOnce(
      Object.assign(new Error('duplicate'), { code: '23505', constraint: 'agents_user_id_name_key' }),
    );
    const response = await send('POST', '/agents', { name: 'Momentum', budget: '100' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'agent_name_taken' });
  });

  it('pauses, archives and renames a simulated agent', async () => {
    for (const state of ['paused', 'archived', 'active']) {
      const response = await send('PATCH', `/agents/${SIMULATED}`, { state });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ state });
    }
    expect((await send('PATCH', `/agents/${SIMULATED}`, { name: 'Value' })).status).toBe(200);
  });

  it('lets a budget fall before the first trade, and only rise after it (decision D22)', async () => {
    expect((await send('PATCH', `/agents/${SIMULATED}`, { budget: '500' })).status).toBe(200);

    vi.mocked(queries.agentHasTraded).mockResolvedValue(true);
    vi.mocked(queries.updateAgent).mockClear();
    const cut = await send('PATCH', `/agents/${SIMULATED}`, { budget: '500' });
    expect(cut.status).toBe(409);
    expect(await cut.json()).toMatchObject({ error: 'budget_decrease_after_trade' });
    expect(queries.updateAgent).not.toHaveBeenCalled();

    const raise = await send('PATCH', `/agents/${SIMULATED}`, { budget: '1500' });
    expect(raise.status).toBe(200);
    expect(await raise.json()).toMatchObject({ budgetMinor: 150000 });
    vi.mocked(queries.agentHasTraded).mockResolvedValue(false);
  });

  it("answers the database's refusal of a cut after a racing trade with the same 409", async () => {
    vi.mocked(queries.updateAgent).mockRejectedValueOnce(
      Object.assign(new Error('budget_decrease_after_trade: an agent that has traded ...'), {
        code: '23514',
      }),
    );
    const response = await send('PATCH', `/agents/${SIMULATED}`, { budget: '500' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'budget_decrease_after_trade' });
  });

  it('never changes the real portfolio (decision D1)', async () => {
    for (const patch of [{ state: 'paused' }, { budget: '100' }, { persona: 'Bold.' }, { name: 'Mine' }]) {
      const response = await send('PATCH', `/agents/${PRIMARY}`, patch);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: 'primary_agent_is_passive' });
    }
    expect(queries.updateAgent).not.toHaveBeenCalled();
  });

  it('refuses a field it does not know rather than ignoring it', async () => {
    const response = await send('PATCH', `/agents/${SIMULATED}`, { isPrimary: true });
    expect(response.status).toBe(400);
  });

  it('is a 404 for an unknown agent and for an id that is not one', async () => {
    expect((await send('GET', '/agents/90000000-0000-0000-0000-0000000000ff')).status).toBe(404);
    expect((await send('GET', '/agents/not-an-id')).status).toBe(404);
    expect(queries.getAgent).toHaveBeenCalledTimes(1);
  });

  it("shows a simulated agent's schedule, model budget and today's spend, and none of it for the primary", async () => {
    const { agents } = await (await send('GET', '/agents')).json();
    expect(agents[1]).toMatchObject({
      scanSchedule: { everyHours: null, preOpen: true, postClose: false },
      runningScan: null,
      llmBudgetMicroUsd: 500_000,
      llmSpentTodayMicroUsd: 108_022,
      scanCost: { microUsd: MEASURED_SCAN_COST_MICRO_USD, basis: 'measured' },
      // Active with no persona: it waits, and is never billed (D52).
      waitingForBrief: true,
    });
    expect(agents[0]).toMatchObject({
      scanSchedule: null,
      llmBudgetMicroUsd: null,
      llmSpentTodayMicroUsd: null,
      scanCost: null,
      waitingForBrief: false,
    });
  });

  it('sets the model budget in dollars and the schedule in its three parts (D45, D195)', async () => {
    const schedule = { everyHours: 2, preOpen: true, postClose: false };
    const response = await send('PATCH', `/agents/${SIMULATED}`, { llmBudget: '1.25', scanSchedule: schedule });
    expect(response.status).toBe(200);
    expect(queries.updateAgent).toHaveBeenCalledWith(USER.id, SIMULATED, expect.objectContaining({
      llmBudgetMicroUsd: 1_250_000,
      scanSchedule: schedule,
    }));
    expect(await response.json()).toMatchObject({ llmBudgetMicroUsd: 1_250_000, scanSchedule: schedule });
  });

  it('sets how many trades a scan may decide, 1 to 10 (D197)', async () => {
    const response = await send('PATCH', `/agents/${SIMULATED}`, { maxDecisions: MAX_DECISIONS_PER_SCAN });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ maxDecisions: MAX_DECISIONS_PER_SCAN });
    for (const maxDecisions of [0, MAX_DECISIONS_PER_SCAN + 1, 2.5, '3']) {
      expect((await send('PATCH', `/agents/${SIMULATED}`, { maxDecisions })).status).toBe(400);
    }
  });

  it('accepts no scheduled scans at all: the agent then scans only when asked (D195)', async () => {
    const none = { everyHours: null, preOpen: false, postClose: false };
    expect((await send('PATCH', `/agents/${SIMULATED}`, { scanSchedule: none })).status).toBe(200);
  });

  it('says which scan is running now, so Run a scan now can wait for it (D195)', async () => {
    vi.mocked(queries.listAgents).mockResolvedValueOnce([
      row({ running_scan: { trigger: 'schedule', started_at: '2026-10-20T14:00:01.5+00:00' } }) as never,
    ]);
    const { agents } = await (await send('GET', '/agents')).json();
    expect(agents[0].runningScan).toEqual({ trigger: 'schedule', startedAt: '2026-10-20T14:00:01.500Z' });
  });

  it('refuses a model budget of nothing or above the ceiling, and an unknown schedule', async () => {
    expect((await send('PATCH', `/agents/${SIMULATED}`, { llmBudget: '0' })).status).toBe(422);
    const over = (MAX_LLM_BUDGET_MICRO_USD / 1_000_000 + 0.01).toFixed(2);
    expect((await send('PATCH', `/agents/${SIMULATED}`, { llmBudget: over })).status).toBe(422);
    expect((await send('PATCH', `/agents/${SIMULATED}`, { llmBudget: '0.001' })).status).toBe(400);
    for (const scanSchedule of [
      'pre_open',
      { everyHours: 0, preOpen: false, postClose: false },
      { everyHours: MAX_SCAN_EVERY_HOURS + 1, preOpen: false, postClose: false },
      { everyHours: 1.5, preOpen: false, postClose: false },
      { everyHours: 2, preOpen: true },
    ]) {
      expect((await send('PATCH', `/agents/${SIMULATED}`, { scanSchedule })).status).toBe(400);
    }
    expect(queries.updateAgent).not.toHaveBeenCalled();
  });

  it('reports how many active agents count against the limit (D72, D199)', async () => {
    vi.mocked(queries.listAgents).mockResolvedValueOnce([
      row({ id: PRIMARY, slug: 'primary-portfolio', name: 'Main portfolio', is_primary: true, budget_minor: null }),
      row(),
      row({ id: randomUUID(), name: 'Resting', state: 'paused' }),
      row({ id: randomUUID(), name: 'Gone', state: 'archived' }),
    ] as never);
    const body = await (await send('GET', '/agents')).json();
    // The primary, a paused and an archived agent never count; the active one does.
    // Against the ceiling (D202) the paused one counts too.
    expect(body.agentLimit).toEqual({ used: 1, max: LIMIT, total: 2 });
  });

  it('refuses a new active agent at the limit before writing anything (D72)', async () => {
    vi.mocked(queries.countActiveAgents).mockResolvedValueOnce(LIMIT);
    const response = await send('POST', '/agents', { name: 'Fourth', budget: '1000' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'agent_limit_reached', details: { max: LIMIT } });
    expect(queries.createAgent).not.toHaveBeenCalled();
  });

  it('creates a paused agent at the limit (D200)', async () => {
    vi.mocked(queries.countActiveAgents).mockResolvedValue(LIMIT);
    const response = await send('POST', '/agents', { name: 'Resting', budget: '1000', state: 'paused' });
    expect(response.status).toBe(201);
    expect(queries.createAgent).toHaveBeenCalledWith(expect.objectContaining({ state: 'paused' }));
    vi.mocked(queries.countActiveAgents).mockResolvedValue(1);
  });

  it('creates an agent active unless told otherwise, and refuses an archived create', async () => {
    expect((await send('POST', '/agents', { name: 'Fresh', budget: '1000' })).status).toBe(201);
    expect(queries.createAgent).toHaveBeenCalledWith(expect.objectContaining({ state: 'active' }));
    expect((await send('POST', '/agents', { name: 'Odd', budget: '1000', state: 'archived' })).status).toBe(400);
  });

  it("answers the database's refusal of a racing create with the same 409", async () => {
    vi.mocked(queries.createAgent).mockRejectedValueOnce(
      Object.assign(new Error(`agent_limit_reached: ${LIMIT} of ${LIMIT} active agents`), { code: '23514' }),
    );
    const response = await send('POST', '/agents', { name: 'Racer', budget: '1000' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'agent_limit_reached' });
  });

  it('refuses a resume and a restore into active at the limit (D199)', async () => {
    vi.mocked(queries.countActiveAgents).mockResolvedValue(LIMIT);
    for (const state of ['paused', 'archived']) {
      vi.mocked(queries.getAgent).mockResolvedValueOnce(row({ state }) as never);
      const response = await send('PATCH', `/agents/${SIMULATED}`, { state: 'active' });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: 'agent_limit_reached' });
    }
    expect(queries.updateAgent).not.toHaveBeenCalled();
    vi.mocked(queries.countActiveAgents).mockResolvedValue(1);
  });

  it('never refuses a pause, an archive, a restore into paused or an edit at the limit (D199)', async () => {
    vi.mocked(queries.countActiveAgents).mockResolvedValue(LIMIT);
    expect((await send('PATCH', `/agents/${SIMULATED}`, { state: 'paused' })).status).toBe(200);
    expect((await send('PATCH', `/agents/${SIMULATED}`, { state: 'archived' })).status).toBe(200);
    // Already active: saying so again takes no new place.
    expect((await send('PATCH', `/agents/${SIMULATED}`, { state: 'active', name: 'Same' })).status).toBe(200);
    vi.mocked(queries.getAgent).mockResolvedValueOnce(row({ state: 'archived' }) as never);
    expect((await send('PATCH', `/agents/${SIMULATED}`, { state: 'paused' })).status).toBe(200);
    expect(queries.countActiveAgents).not.toHaveBeenCalled();
    vi.mocked(queries.countActiveAgents).mockResolvedValue(1);
  });

  it('gives the admin no limit (D201)', async () => {
    vi.mocked(queries.getUser).mockResolvedValue({ ...USER, role: 'admin' } as never);
    vi.mocked(queries.countActiveAgents).mockResolvedValue(LIMIT + 10);
    vi.mocked(queries.countLiveAgents).mockResolvedValue(MAX_AGENTS_PER_USER_CEILING);
    try {
      expect((await (await send('GET', '/agents')).json()).agentLimit).toEqual({ used: 1, max: null, total: null });
      expect((await send('POST', '/agents', { name: 'Many', budget: '1000' })).status).toBe(201);
      vi.mocked(queries.getAgent).mockResolvedValueOnce(row({ state: 'paused' }) as never);
      expect((await send('PATCH', `/agents/${SIMULATED}`, { state: 'active' })).status).toBe(200);
      // Nor a ceiling (D202).
      vi.mocked(queries.getAgent).mockResolvedValueOnce(row({ state: 'archived' }) as never);
      expect((await send('PATCH', `/agents/${SIMULATED}`, { state: 'paused' })).status).toBe(200);
    } finally {
      vi.mocked(queries.getUser).mockResolvedValue(USER as never);
      vi.mocked(queries.countActiveAgents).mockResolvedValue(1);
      vi.mocked(queries.countLiveAgents).mockResolvedValue(1);
    }
  });

  it(`refuses a create in any state at ${MAX_AGENTS_PER_USER_CEILING} agents that are not archived (D202)`, async () => {
    vi.mocked(queries.countLiveAgents).mockResolvedValue(MAX_AGENTS_PER_USER_CEILING);
    try {
      for (const state of ['active', 'paused'] as const) {
        const response = await send('POST', '/agents', { name: 'One more', budget: '1000', state });
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ error: 'agent_total_reached' });
      }
      expect(queries.createAgent).not.toHaveBeenCalled();
    } finally {
      vi.mocked(queries.countLiveAgents).mockResolvedValue(1);
    }
  });

  it('refuses a restore at the ceiling, and never a pause, a resume or an archive (D202)', async () => {
    vi.mocked(queries.countLiveAgents).mockResolvedValue(MAX_AGENTS_PER_USER_CEILING);
    try {
      for (const state of ['active', 'paused'] as const) {
        vi.mocked(queries.getAgent).mockResolvedValueOnce(row({ state: 'archived' }) as never);
        const response = await send('PATCH', `/agents/${SIMULATED}`, { state });
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ error: 'agent_total_reached' });
      }
      expect((await send('PATCH', `/agents/${SIMULATED}`, { state: 'paused' })).status).toBe(200);
      expect((await send('PATCH', `/agents/${SIMULATED}`, { state: 'archived' })).status).toBe(200);
      vi.mocked(queries.getAgent).mockResolvedValueOnce(row({ state: 'paused' }) as never);
      expect((await send('PATCH', `/agents/${SIMULATED}`, { state: 'active' })).status).toBe(200);
    } finally {
      vi.mocked(queries.countLiveAgents).mockResolvedValue(1);
    }
  });

  it("answers the database's ceiling refusal of a racing create with the same 409", async () => {
    vi.mocked(queries.createAgent).mockRejectedValueOnce(
      Object.assign(new Error('agent_total_reached: 50 of 50 agents'), { code: '23514' }),
    );
    const response = await send('POST', '/agents', { name: 'Racer', budget: '1000', state: 'paused' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'agent_total_reached' });
  });

  it("says where and when an agent's scheduled scans run (D71)", async () => {
    // Off here: the test env sets no ENABLE_SCHEDULED_SCANS.
    expect((await (await send('GET', `/agents/${SIMULATED}`)).json()).scheduling).toEqual({ enabled: false, nextAt: null });

    resetConfigForTests();
    const ai = createFakeAi();
    Object.assign(ai, {
      marketSessions: vi.fn(async () => ({
        exchange: 'NMS',
        calendar: 'XNYS',
        sessions: [{ day: '2099-01-05', opens_at: '2099-01-05T14:30:00Z', closes_at: '2099-01-05T21:00:00Z', early_close: false }],
      })),
    });
    const on = createApp(loadConfig({ ...ENV, ENABLE_SCHEDULED_SCANS: 'true' } as unknown as NodeJS.ProcessEnv), ai);
    vi.mocked(queries.getAgent).mockResolvedValueOnce(row({ persona: 'Patient.' }) as never);
    const body = await (await on.request(`/agents/${SIMULATED}`, { headers: { ...ORIGIN, cookie } })).json();
    expect(body.scheduling).toEqual({ enabled: true, nextAt: '2099-01-05T14:00:00.000Z' });
  });
});

describe("an agent's mandate (0057, D165)", () => {
  let app: ReturnType<typeof buildApp>;
  let cookie: string;

  const send = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { ...ORIGIN, cookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  beforeEach(async () => {
    vi.clearAllMocks();
    app = buildApp();
    cookie = sessionCookie();
  });

  it('creates an agent with a mandate, and its horizon brings its schedule (D166)', async () => {
    const response = await send('POST', '/agents', {
      name: 'Miner',
      budget: '1000',
      mandate: { horizon: 'short', maxPositionBps: 1000, sectors: ['Energy'], blockedSymbols: ['xom', 'XOM'] },
    });
    expect(response.status).toBe(201);
    const created = vi.mocked(queries.createAgent).mock.calls[0]![0];
    expect(created.scanSchedule).toEqual(HORIZON_SCHEDULES.short);
    expect(created.maxDecisions).toBe(HORIZON_MAX_DECISIONS.short);
    expect(created.mandate).toMatchObject({
      horizon: 'short',
      max_position_bps: 1000,
      cash_buffer_bps: null,
      allow_etfs: true,
      sectors: ['Energy'],
      blocked_symbols: ['XOM'],
    });
  });

  it('keeps a chosen schedule over the horizon, and gives an agent with neither the default', async () => {
    const chosen = { everyHours: 6, preOpen: false, postClose: false };
    await send('POST', '/agents', { name: 'A', budget: '1', mandate: { horizon: 'long' }, scanSchedule: chosen });
    await send('POST', '/agents', { name: 'B', budget: '1' });
    const calls = vi.mocked(queries.createAgent).mock.calls.map(([agent]) => agent.scanSchedule);
    expect(calls).toEqual([chosen, { everyHours: null, preOpen: true, postClose: false }]);
    expect(vi.mocked(queries.createAgent).mock.calls.map(([agent]) => agent.maxDecisions)).toEqual([
      HORIZON_MAX_DECISIONS.long,
      1,
    ]);
  });

  it('refuses a sector, industry or ETF category the universe does not hold, naming it', async () => {
    const response = await send('POST', '/agents', {
      name: 'Typo',
      budget: '1000',
      mandate: { sectors: ['Technolgy'], industries: ['Uranium'], etfCategories: ['Large Blend', 'Gold'] },
    });
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body).toMatchObject({ error: 'unknown_classification' });
    expect(body.details).toEqual({ sectors: ['Technolgy'], industries: [], etfCategories: ['Gold'] });
    expect(queries.createAgent).not.toHaveBeenCalled();
  });

  it('refuses limits outside what the database allows, before any SQL', async () => {
    for (const mandate of [
      { maxPositionBps: 0 },
      { maxPositionBps: 10_001 },
      { cashBufferBps: 10_000 },
      { maxHoldings: 0 },
      { riskLevel: 11 },
      { horizon: 'day' },
      { marketCaps: ['nano'] },
      { blockedSymbols: ['not a ticker'] },
      { allowList: ['NVDA'] },
    ]) {
      const response = await send('PATCH', `/agents/${SIMULATED}`, { mandate });
      expect(response.status, JSON.stringify(mandate)).toBe(400);
    }
    expect(queries.updateAgent).not.toHaveBeenCalled();
  });

  it('changes only the mandate fields an edit names', async () => {
    const response = await send('PATCH', `/agents/${SIMULATED}`, { mandate: { allowEtfs: false, marketCaps: ['large'] } });
    expect(response.status).toBe(200);
    expect(vi.mocked(queries.updateAgent).mock.calls[0]![2].mandate).toEqual({ allow_etfs: false, market_caps: ['large'] });
  });

  it('reads the mandate back on a simulated agent, and none on the primary (D1)', async () => {
    vi.mocked(queries.getAgent).mockResolvedValueOnce(row({ max_position_bps: 1250, sectors: ['Energy'] }) as never);
    const agent = await (await send('GET', `/agents/${SIMULATED}`)).json();
    expect(agent.mandate).toMatchObject({ maxPositionBps: 1250, sectors: ['Energy'], allowEtfs: true, horizon: null });
    const primary = await (await send('GET', `/agents/${PRIMARY}`)).json();
    expect(primary.mandate).toBeNull();
  });
});

describe('the cost of a scan (D46)', () => {
  const base = row() as never;
  it("is the agent's own average, else the installation's, else what was measured", () => {
    expect(scanCostOf({ ...(base as object), agent_scan_cost_micro_usd: '41000', installation_scan_cost_micro_usd: '30000' } as never))
      .toEqual({ microUsd: 41_000, basis: 'agent' });
    expect(scanCostOf({ ...(base as object), installation_scan_cost_micro_usd: '30000' } as never))
      .toEqual({ microUsd: 30_000, basis: 'installation' });
    expect(scanCostOf(base)).toEqual({ microUsd: MEASURED_SCAN_COST_MICRO_USD, basis: 'measured' });
  });
});
