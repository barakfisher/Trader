/**
 * The consolidated holdings view (Stage 3, PR 6; spec §4.3, D32-D35).
 *
 * The database layer is mocked; valuation runs for real against the fake AI
 * service's prices. Pinned: one row per instrument with the per-agent split;
 * real and simulated reported side by side and never summed; a paused agent
 * included and an archived one left out (D18); an unpriced simulated holding
 * blanks the simulated totals rather than shrinking them (decision 111), while
 * the real summary keeps its own partial-and-marked rule.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createFakeAi } from './fakeAi.js';

const USER = { id: '00000000-0000-0000-0000-000000000001', email: null, base_currency: 'USD', timezone: 'Asia/Jerusalem' };
const PRIMARY = '90000000-0000-0000-0000-000000000001';
const MOMENTUM = '90000000-0000-0000-0000-0000000000a1';
const VALUE = '90000000-0000-0000-0000-0000000000a2';
const OLD = '90000000-0000-0000-0000-0000000000a3';

function agentRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    slug: id,
    name: id,
    persona: null,
    is_primary: false,
    budget_minor: '100000',
    currency: 'USD',
    state: 'active',
    created_at: new Date('2026-10-05T10:00:00Z'),
    holdings_count: 0,
    cash_minor: '50000',
    ...overrides,
  };
}

function holding(agent: string, symbol: string, quantity: string, cost: string | null) {
  return {
    id: `h-${agent}-${symbol}`,
    user_id: USER.id,
    instrument_id: `i-${symbol}`,
    quantity,
    cost_basis_minor: cost,
    currency: 'USD',
    opened_at: null,
    notes: null,
    symbol,
    name: symbol,
    asset_class: 'equity',
    exchange: 'NMS',
    instrument_currency: 'USD',
  };
}

let agents: ReturnType<typeof agentRow>[] = [];
let openProposals: Record<string, unknown>[] = [];

function tradeProposal(id: string, agent: string, symbol: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    kind: 'buy',
    agent_id: agent,
    agent_name: agent === MOMENTUM ? 'Momentum' : agent,
    payload: { symbol, quantity: '2', priceMinor: 23_868, priceAsOf: null, currency: 'USD' },
    state: 'pending',
    expires_at: new Date(Date.now() + 3_600_000),
    snoozed_until: null,
    decided_at: null,
    ...overrides,
  };
}
let holdingsByAgent: Record<string, ReturnType<typeof holding>[]> = {};

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
  listAgents: vi.fn(async () => agents),
  listHoldings: vi.fn(async (_user: string, agentId: string) => holdingsByAgent[agentId] ?? []),
  recordQuotes: vi.fn(async () => undefined),
  listProposals: vi.fn(async () => openProposals),
}));

const queries = await import('../src/db/queries.js');
const { loadConfig, resetConfigForTests } = await import('../src/config.js');
const { createApp } = await import('../src/http/app.js');
const { addQuantities } = await import('../src/services/consolidation.js');

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

async function consolidated(ai = createFakeAi()) {
  resetConfigForTests();
  const app = createApp(loadConfig(ENV), ai);
  const login = await app.request('/auth/login', {
    method: 'POST',
    headers: ORIGIN,
    body: JSON.stringify({ passphrase: 'test-passphrase' }),
  });
  const cookie = (login.headers.get('set-cookie') as string).split(';')[0]!;
  const response = await app.request('/portfolio/consolidated', { headers: { ...ORIGIN, cookie } });
  expect(response.status).toBe(200);
  return response.json();
}

// The fake AI's prices, in minor units.
const AAPL = 23214;
const VOO = 51208;

beforeEach(() => {
  vi.clearAllMocks();
  openProposals = [];
  agents = [
    agentRow(PRIMARY, { name: 'Main portfolio', is_primary: true, budget_minor: null, cash_minor: null }),
    agentRow(MOMENTUM, { name: 'Momentum' }),
    agentRow(VALUE, { name: 'Value', state: 'paused', cash_minor: '20000' }),
    agentRow(OLD, { name: 'Old', state: 'archived' }),
  ];
  holdingsByAgent = {
    [PRIMARY]: [holding(PRIMARY, 'AAPL', '40.000000000000000000', '15000'), holding(PRIMARY, 'VOO', '2.500000000000000000', '40000')],
    [MOMENTUM]: [holding(MOMENTUM, 'AAPL', '5.000000000000000000', '22000')],
    [VALUE]: [holding(VALUE, 'AAPL', '3.000000000000000000', '21000')],
    [OLD]: [holding(OLD, 'AAPL', '100.000000000000000000', '10000')],
  };
});

describe('the consolidated view', () => {
  it('is one row per instrument, real and simulated side by side, never summed', async () => {
    const body = await consolidated();
    expect(body.rows.map((row: { instrument: { symbol: string } }) => row.instrument.symbol)).toEqual(['AAPL', 'VOO']);
    const aapl = body.rows[0];
    expect(aapl.real).toEqual({ quantity: '40.000000000000000000', valueMinor: 40 * AAPL });
    expect(aapl.simulated).toEqual({ quantity: '8.000000000000000000', valueMinor: 8 * AAPL });
    expect(aapl.quote.priceMinor).toBe(AAPL);
    // VOO is held only by the real portfolio.
    expect(body.rows[1].simulated).toBeNull();
  });

  it('expands to each agent, the real portfolio first, a paused agent marked and an archived one absent (D18)', async () => {
    const body = await consolidated();
    expect(body.rows[0].positions).toEqual([
      expect.objectContaining({ agentId: PRIMARY, isPrimary: true, quantity: '40.000000000000000000' }),
      expect.objectContaining({ agentId: MOMENTUM, isPrimary: false, state: 'active', valueMinor: 5 * AAPL, pnlMinor: 5 * (AAPL - 22000) }),
      expect.objectContaining({ agentId: VALUE, state: 'paused', quantity: '3.000000000000000000' }),
    ]);
    expect(body.agents.map((agent: { agentId: string }) => agent.agentId)).toEqual([MOMENTUM, VALUE]);
    expect(queries.listHoldings).not.toHaveBeenCalledWith(USER.id, OLD);
  });

  it('reports the real summary as /portfolio does, and the simulated totals as cash plus market value (D34)', async () => {
    const body = await consolidated();
    expect(body.currency).toBe('USD');
    expect(body.real.totalValueMinor).toBe(40 * AAPL + Math.round(2.5 * VOO));
    expect(body.simulated).toEqual({
      agentCount: 2,
      cashMinor: 50000 + 20000,
      holdingsValueMinor: 8 * AAPL,
      netWorthMinor: 70000 + 8 * AAPL,
      unpricedSymbols: [],
    });
    expect(body.agents[1]).toMatchObject({ name: 'Value', state: 'paused', cashMinor: 20000, netWorthMinor: 20000 + 3 * AAPL });
  });

  it('blanks the simulated totals when an agent holds something unpriced, and names it (decision 111)', async () => {
    holdingsByAgent[VALUE] = [holding(VALUE, 'NOPE', '1.000000000000000000', '100')];
    const body = await consolidated();
    expect(body.simulated).toMatchObject({ cashMinor: 70000, holdingsValueMinor: null, netWorthMinor: null, unpricedSymbols: ['NOPE'] });
    expect(body.agents[0].netWorthMinor).toBe(50000 + 5 * AAPL);
    const nope = body.rows.find((row: { instrument: { symbol: string } }) => row.instrument.symbol === 'NOPE');
    expect(nope).toMatchObject({ real: null, simulated: { quantity: '1.000000000000000000', valueMinor: null }, quote: null });
    // The real side is untouched: it keeps its own rule.
    expect(body.real.degraded).toBe(false);
  });

  it('is the real portfolio alone for a user with no simulated agent', async () => {
    agents = [agents[0]!];
    const body = await consolidated();
    expect(body.agents).toEqual([]);
    expect(body.simulated).toEqual({ agentCount: 0, cashMinor: 0, holdingsValueMinor: 0, netWorthMinor: 0, unpricedSymbols: [] });
    expect(body.rows.every((row: { simulated: unknown }) => row.simulated === null)).toBe(true);
  });
});

describe('addQuantities', () => {
  it('adds exactly, never through a float (guideline 4)', () => {
    expect(addQuantities(['0.1', '0.2'])).toBe('0.300000000000000000');
    expect(addQuantities(['12345678901234567890.000000000000000001', '1'])).toBe('12345678901234567891.000000000000000001');
    expect(addQuantities([])).toBe('0.000000000000000000');
  });
});

describe('pending trade proposals (D35, D63)', () => {
  it("lists the shown agents' answerable trades, soonest first, held or not", async () => {
    openProposals = [
      tradeProposal('p-later', MOMENTUM, 'NVDA', { expires_at: new Date(Date.now() + 7_200_000) }),
      tradeProposal('p-sooner', MOMENTUM, 'AAPL'),
      // Past its deadline but not yet swept: no longer answerable.
      tradeProposal('p-expired', MOMENTUM, 'AAPL', { expires_at: new Date(Date.now() - 1000) }),
      // An archived agent's is not shown, as its holdings are not (D18).
      tradeProposal('p-archived', OLD, 'AAPL'),
      // A rebalance is the real portfolio's question, not a trade.
      tradeProposal('p-rebalance', PRIMARY, 'VOO', { kind: 'rebalance' }),
    ];
    const body = await consolidated();
    expect(queries.listProposals).toHaveBeenCalledWith(USER.id, { open: true });
    expect(body.pendingTrades).toEqual([
      expect.objectContaining({ proposalId: 'p-sooner', agentId: MOMENTUM, agentName: 'Momentum', side: 'buy', symbol: 'AAPL', quantity: '2', agentPriceMinor: 23_868, currency: 'USD' }),
      expect.objectContaining({ proposalId: 'p-later', symbol: 'NVDA' }),
    ]);
  });

  it('is empty when nothing is waiting', async () => {
    expect((await consolidated()).pendingTrades).toEqual([]);
  });
});
