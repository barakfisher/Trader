/**
 * The agents API (multi-agent Stage 2): what it accepts, what it refuses before
 * any SQL runs, and that the real portfolio cannot be changed through it.
 *
 * The database layer is mocked, as in settings.test.ts: every rule asserted here
 * is one this process applies itself. The SQL is exercised against Postgres in
 * queries.postgres.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = {
  id: '00000000-0000-0000-0000-000000000001',
  email: null,
  base_currency: 'USD',
  timezone: 'Asia/Jerusalem',
};
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
    scan_schedule: 'pre_open',
    llm_spent_today_micro_usd: '108022',
    agent_scan_cost_micro_usd: null,
    installation_scan_cost_micro_usd: null,
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
  agentHasTraded: vi.fn(async () => false),
  getInstallationSettings: vi.fn(async () => ({ max_agents_per_user: 3, updated_at: new Date() })),
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
      ...(patch.scanSchedule === undefined ? {} : { scan_schedule: patch.scanSchedule }),
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
  APP_PASSPHRASE: 'test-passphrase',
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
    const login = await app.request('/auth/login', {
      method: 'POST',
      headers: ORIGIN,
      body: JSON.stringify({ passphrase: 'test-passphrase' }),
    });
    cookie = (login.headers.get('set-cookie') as string).split(';')[0]!;
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
      scanSchedule: 'pre_open',
      llmBudgetMicroUsd: 500_000,
      llmSpentTodayMicroUsd: 108_022,
      scanCost: { microUsd: MEASURED_SCAN_COST_MICRO_USD, basis: 'measured' },
      // Active with no persona: it waits, and is never billed (D52).
      waitingForPersona: true,
    });
    expect(agents[0]).toMatchObject({
      scanSchedule: null,
      llmBudgetMicroUsd: null,
      llmSpentTodayMicroUsd: null,
      scanCost: null,
      waitingForPersona: false,
    });
  });

  it('sets the model budget in dollars and the schedule from its four choices (D45, D46)', async () => {
    const response = await send('PATCH', `/agents/${SIMULATED}`, { llmBudget: '1.25', scanSchedule: 'intraday_twice' });
    expect(response.status).toBe(200);
    expect(queries.updateAgent).toHaveBeenCalledWith(USER.id, SIMULATED, expect.objectContaining({
      llmBudgetMicroUsd: 1_250_000,
      scanSchedule: 'intraday_twice',
    }));
    expect(await response.json()).toMatchObject({ llmBudgetMicroUsd: 1_250_000, scanSchedule: 'intraday_twice' });
  });

  it('refuses a model budget of nothing or above the ceiling, and an unknown schedule', async () => {
    expect((await send('PATCH', `/agents/${SIMULATED}`, { llmBudget: '0' })).status).toBe(422);
    const over = (MAX_LLM_BUDGET_MICRO_USD / 1_000_000 + 0.01).toFixed(2);
    expect((await send('PATCH', `/agents/${SIMULATED}`, { llmBudget: over })).status).toBe(422);
    expect((await send('PATCH', `/agents/${SIMULATED}`, { llmBudget: '0.001' })).status).toBe(400);
    expect((await send('PATCH', `/agents/${SIMULATED}`, { scanSchedule: 'hourly' })).status).toBe(400);
    expect(queries.updateAgent).not.toHaveBeenCalled();
  });

  it('reports how many agents count against the limit (D71)', async () => {
    const body = await (await send('GET', '/agents')).json();
    // The primary never counts; the one active simulated agent does.
    expect(body.agentLimit).toEqual({ used: 1, max: 3 });
  });

  it('refuses a new agent at the limit before writing anything (D71)', async () => {
    vi.mocked(queries.countLiveAgents).mockResolvedValueOnce(3);
    const response = await send('POST', '/agents', { name: 'Fourth', budget: '1000' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'agent_limit_reached' });
    expect(queries.createAgent).not.toHaveBeenCalled();
  });

  it("answers the database's refusal of a racing create with the same 409", async () => {
    vi.mocked(queries.createAgent).mockRejectedValueOnce(
      Object.assign(new Error('agent_limit_reached: 3 of 3 agents'), { code: '23514' }),
    );
    const response = await send('POST', '/agents', { name: 'Racer', budget: '1000' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'agent_limit_reached' });
  });

  it('refuses a restore from the archive at the limit, and allows pausing or archiving at it', async () => {
    vi.mocked(queries.getAgent).mockResolvedValueOnce(row({ state: 'archived' }) as never);
    vi.mocked(queries.countLiveAgents).mockResolvedValueOnce(3);
    expect((await send('PATCH', `/agents/${SIMULATED}`, { state: 'active' })).status).toBe(409);
    vi.mocked(queries.countLiveAgents).mockResolvedValue(3);
    expect((await send('PATCH', `/agents/${SIMULATED}`, { state: 'archived' })).status).toBe(200);
    vi.mocked(queries.countLiveAgents).mockResolvedValue(1);
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
