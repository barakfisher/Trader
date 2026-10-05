/**
 * A simulated agent's account, activity timeline and added cash (Stage 3, PR 5).
 *
 * The database layer is mocked; the valuation runs for real against the fake AI
 * service's prices. Pinned: net worth is cash plus market value and P&L is net
 * worth minus deposits (D6); an unpriced holding leaves both null rather than
 * partial (guideline 7); the timeline carries each movement's fill and balance
 * (D31); added cash is a positive amount, refused on an archived agent and on
 * the real portfolio (D1, D22).
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
    budget_minor: '100000',
    currency: 'USD',
    state: 'active',
    created_at: new Date('2026-10-05T10:00:00Z'),
    holdings_count: 1,
    cash_minor: '30000',
    ...overrides,
  };
}

function holding(symbol: string, quantity: string, cost: string) {
  return {
    id: `h-${symbol}`,
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

let agent = agentRow();
let holdings = [holding('AAPL', '3.000000000000000000', '20000')];

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
  getAgent: vi.fn(async (_u: string, id: string) =>
    id === PRIMARY ? agentRow({ id: PRIMARY, is_primary: true, budget_minor: null, cash_minor: null }) : id === AGENT ? agent : null,
  ),
  listHoldings: vi.fn(async () => holdings),
  recordQuotes: vi.fn(async () => undefined),
  listCashActivity: vi.fn(async () => [
    { id: 'm-2', kind: 'buy', amount_minor: '-60150', balance_after_minor: '39850', created_at: new Date('2026-10-05T16:40:00Z'), fill_id: 'f-1' },
    { id: 'm-1', kind: 'opening_deposit', amount_minor: '100000', balance_after_minor: '100000', created_at: new Date('2026-10-05T10:00:00Z'), fill_id: null },
  ]),
  listFillsByIds: vi.fn(async () => [
    {
      id: 'f-1',
      agent_id: AGENT,
      instrument_id: 'i-AAPL',
      symbol: 'AAPL',
      side: 'buy',
      quantity: '3.000000000000000000',
      price_minor: '20000',
      notional_minor: '60000',
      fee_minor: '150',
      currency: 'USD',
      price_source: 'quote',
      quote_as_of: new Date('2026-10-05T16:30:00Z'),
      quote_delay_seconds: 900,
      source: 'manual_user_override',
      proposal_id: null,
      idempotency_key: 'k',
      created_at: new Date('2026-10-05T16:40:00Z'),
    },
  ]),
  topUpAgent: vi.fn(async () => ({ budget_minor: '150000' })),
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
} as unknown as NodeJS.ProcessEnv;
const ORIGIN = { origin: 'http://localhost:5173', 'content-type': 'application/json' };

async function signedIn(ai = createFakeAi()) {
  resetConfigForTests();
  const app = createApp(loadConfig(ENV), ai);
  const login = await app.request('/auth/login', {
    method: 'POST',
    headers: ORIGIN,
    body: JSON.stringify({ passphrase: 'test-passphrase' }),
  });
  const cookie = (login.headers.get('set-cookie') as string).split(';')[0]!;
  return (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { ...ORIGIN, cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  agent = agentRow();
  holdings = [holding('AAPL', '3.000000000000000000', '20000')];
});

describe('the account', () => {
  it('is cash plus market value, and P&L is net worth minus deposits', async () => {
    const send = await signedIn();
    const response = await send('GET', `/agents/${AGENT}/account`);
    expect(response.status).toBe(200);
    const body = await response.json();
    const marketValue = 3 * 23214; // the fake AI's AAPL price
    expect(body).toMatchObject({
      cashMinor: 30000,
      depositsMinor: 100000,
      holdingsValueMinor: marketValue,
      netWorthMinor: 30000 + marketValue,
      pnlMinor: 30000 + marketValue - 100000,
    });
    expect(body.pnlPct).toBeCloseTo(((30000 + marketValue - 100000) / 100000) * 100, 10);
  });

  it('leaves net worth and P&L null when a holding is unpriced, never partial', async () => {
    holdings = [holding('AAPL', '3', '20000'), holding('VOO', '1', '50000')];
    const send = await signedIn(createFakeAi({ unpriceable: ['VOO'] }));
    const body = await (await send('GET', `/agents/${AGENT}/account`)).json();
    expect(body).toMatchObject({ cashMinor: 30000, holdingsValueMinor: null, netWorthMinor: null, pnlMinor: null, pnlPct: null });
    expect(body.portfolio.summary.unpricedSymbols).toEqual(['VOO']);
  });

  it('has none for the real portfolio (D1)', async () => {
    const send = await signedIn();
    const response = await send('GET', `/agents/${PRIMARY}/account`);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'primary_agent_is_passive' });
  });
});

describe('the activity timeline (D31)', () => {
  it('lists each movement with its balance, and the fill behind a trade', async () => {
    const send = await signedIn();
    const body = await (await send('GET', `/agents/${AGENT}/activity`)).json();
    expect(body.entries).toEqual([
      expect.objectContaining({
        kind: 'buy',
        amountMinor: -60150,
        balanceAfterMinor: 39850,
        fill: expect.objectContaining({ symbol: 'AAPL', quantity: '3', priceMinor: 20000, feeMinor: 150 }),
      }),
      expect.objectContaining({ kind: 'opening_deposit', amountMinor: 100000, balanceAfterMinor: 100000, fill: null }),
    ]);
    expect(queries.listFillsByIds).toHaveBeenCalledWith(USER.id, AGENT, ['f-1']);
  });
});

describe('adding cash (D22)', () => {
  it('raises the budget by the amount in minor units', async () => {
    const send = await signedIn();
    const response = await send('POST', `/agents/${AGENT}/top-ups`, { amount: '500.25' });
    expect(response.status).toBe(200);
    expect(queries.topUpAgent).toHaveBeenCalledWith(USER.id, AGENT, 50025, expect.any(Number));
  });

  it('refuses a malformed or zero amount, an archived agent, and the real portfolio', async () => {
    const send = await signedIn();
    expect((await send('POST', `/agents/${AGENT}/top-ups`, { amount: '1.234' })).status).toBe(400);
    expect((await send('POST', `/agents/${AGENT}/top-ups`, { amount: '0' })).status).toBe(422);
    expect((await send('POST', `/agents/${AGENT}/top-ups`, { amount: '5', extra: 1 })).status).toBe(400);
    expect((await send('POST', `/agents/${PRIMARY}/top-ups`, { amount: '5' })).status).toBe(409);
    agent = agentRow({ state: 'archived' });
    const archived = await send('POST', `/agents/${AGENT}/top-ups`, { amount: '5' });
    expect(archived.status).toBe(409);
    expect(await archived.json()).toMatchObject({ error: 'agent_archived' });
    expect(queries.topUpAgent).not.toHaveBeenCalled();
  });

  it('says so when the ceiling would be passed', async () => {
    vi.mocked(queries.topUpAgent).mockResolvedValueOnce(null);
    const send = await signedIn();
    const response = await send('POST', `/agents/${AGENT}/top-ups`, { amount: '5' });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: 'budget_out_of_range' });
  });
});
