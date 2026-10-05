/**
 * The performance route and the backfill that feeds it (Stage 3, PR 7).
 *
 * The database layer is mocked; the AI service is the fake with the calendar
 * and history it is asked for. Pinned: the route reads the calendar of the
 * benchmark's exchange over New York days from the first deposit, and the
 * closes of every traded instrument and of SPY; the real portfolio has no
 * performance (D1); the backfill fetches the benchmark and every instrument an
 * agent ever traded, beside what is held and followed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createFakeAi } from './fakeAi.js';

const USER = { id: '00000000-0000-0000-0000-000000000001', email: null, base_currency: 'USD', timezone: 'Asia/Jerusalem' };
const PRIMARY = '90000000-0000-0000-0000-000000000001';
const AGENT = '90000000-0000-0000-0000-0000000000a1';

function agentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT,
    slug: 'agent-1',
    name: 'Momentum',
    persona: null,
    is_primary: false,
    budget_minor: '1000000',
    currency: 'USD',
    state: 'active',
    created_at: new Date('2026-10-01T14:00:00Z'),
    holdings_count: 0,
    cash_minor: '1000000',
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
  primaryAgentId: vi.fn(async () => PRIMARY),
  getAgent: vi.fn(async (_u: string, id: string) =>
    id === PRIMARY ? agentRow({ id: PRIMARY, is_primary: true, budget_minor: null, cash_minor: null }) : id === AGENT ? agentRow() : null,
  ),
  listCashTimeline: vi.fn(async () => [
    {
      id: 'm-1',
      kind: 'opening_deposit',
      amount_minor: '1000000',
      balance_after_minor: '1000000',
      created_at: new Date('2026-10-01T14:00:00Z'),
      fill_id: null,
    },
  ]),
  listFillsOldestFirst: vi.fn(async () => []),
  findInstrumentsBySymbols: vi.fn(async () => [
    { id: 'i-SPY', symbol: 'SPY', name: 'SPDR S&P 500', asset_class: 'etf', exchange: 'PCX', currency: 'USD' },
  ]),
  claimRun: vi.fn(async () => ({ claimed: true, runId: 'run-1' })),
  finishRun: vi.fn(async () => undefined),
  listAnalysedInstruments: vi.fn(async () => [{ id: 'i-AAPL', symbol: 'AAPL', name: 'Apple', asset_class: 'equity' }]),
  listTradedInstruments: vi.fn(async () => [
    { id: 'i-AAPL', symbol: 'AAPL' },
    { id: 'i-NVDA', symbol: 'NVDA' },
  ]),
}));

const queries = await import('../src/db/queries.js');
const { loadConfig, resetConfigForTests } = await import('../src/config.js');
const { createApp } = await import('../src/http/app.js');

const ENV = {
  APP_ENV: 'test',
  LOG_LEVEL: 'error',
  APP_PASSPHRASE: 'test-passphrase',
  SESSION_SECRET: 'test-session-secret-value',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  AI_SERVICE_URL: 'http://ai-service:8000',
  INTERNAL_API_KEY: 'internal-test-key',
  ALLOWED_ORIGINS: 'http://localhost:5173',
  SINGLE_USER_ID: USER.id,
} as unknown as NodeJS.ProcessEnv;
const ORIGIN = { origin: 'http://localhost:5173', 'content-type': 'application/json' };

function aiWithHistory() {
  return {
    ...createFakeAi(),
    marketSessions: vi.fn(async (exchange: string) => ({
      exchange,
      calendar: 'XNYS',
      sessions: [{ day: '2026-10-01', opens_at: '2026-10-01T13:30:00Z', closes_at: '2026-10-01T20:00:00Z', early_close: false }],
    })),
    priceHistory: vi.fn(async (instrumentId: string, days: number) => ({
      instrument_id: instrumentId,
      days,
      closes: [{ day: '2026-10-01', price_minor: 60_000, currency: 'USD', as_of: '2026-10-01T20:00:00Z' }],
    })),
    backfillHistory: vi.fn(async () => ({ written: 0, already_present: 0, without_history: [] })),
  };
}

async function app(ai = aiWithHistory()) {
  resetConfigForTests();
  const instance = createApp(loadConfig(ENV), ai as never);
  const login = await instance.request('/auth/login', {
    method: 'POST',
    headers: ORIGIN,
    body: JSON.stringify({ passphrase: 'test-passphrase' }),
  });
  const cookie = (login.headers.get('set-cookie') as string).split(';')[0]!;
  return { instance, cookie, ai };
}

beforeEach(() => vi.clearAllMocks());

describe('GET /agents/:id/performance', () => {
  it("reads the benchmark exchange's calendar in New York days, and the benchmark's closes", async () => {
    const { instance, cookie, ai } = await app();
    const response = await instance.request(`/agents/${AGENT}/performance`, { headers: { ...ORIGIN, cookie } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(ai.marketSessions).toHaveBeenCalledWith('PCX', '2026-10-01', expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), expect.anything());
    expect(ai.priceHistory).toHaveBeenCalledWith('i-SPY', expect.any(Number), expect.anything());
    // The deposit bought SPY at that day's close: worth the deposit, no gain.
    expect(body.benchmarkSymbol).toBe('SPY');
    expect(body.series).toEqual([
      { day: '2026-10-01', netWorthMinor: 1_000_000, benchmarkMinor: 1_000_000, depositsMinor: 1_000_000 },
    ]);
    expect(body.score.agentDecisions).toBe(0);
  });

  it('has none for the real portfolio (D1)', async () => {
    const { instance, cookie } = await app();
    const response = await instance.request(`/agents/${PRIMARY}/performance`, { headers: { ...ORIGIN, cookie } });
    expect(response.status).toBe(409);
  });
});

describe('the backfill', () => {
  it('fetches the benchmark and every traded instrument, once each, beside what is held', async () => {
    const { instance, ai } = await app();
    const response = await instance.request('/internal/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': 'internal-test-key' },
      body: JSON.stringify({ kind: 'backfill' }),
    });
    expect(response.status).toBe(200);
    const sent = (ai.backfillHistory.mock.calls as unknown[][])[0]![0] as { instruments: { symbol: string }[] };
    expect(sent.instruments.map((row) => row.symbol).sort()).toEqual(['AAPL', 'NVDA', 'SPY']);
    expect(queries.listTradedInstruments).toHaveBeenCalledWith(USER.id);
  });
});
