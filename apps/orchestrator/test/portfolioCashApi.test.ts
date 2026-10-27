/**
 * The real portfolio's cash (D328-D330, D340-D342): unset until the user sets
 * it, opened with the holdings' cost at that moment, moved for a named reason
 * and corrected. The database is mocked; the triggers and the movement function
 * run against Postgres in test_ledger_sql.py.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTIVE_SESSION, sessionCookie } from './session.js';

const USER = {
  ...ACTIVE_SESSION,
  id: '00000000-0000-0000-0000-000000000001',
  email: null,
  base_currency: 'USD',
  timezone: 'Asia/Jerusalem',
};
const PRIMARY = '90000000-0000-0000-0000-000000000001';

vi.mock('../src/db/pool.js', () => ({
  queryOne: vi.fn(async () => ({ ok: 1 })),
  query: vi.fn(async () => []),
  transaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({})),
  initPool: vi.fn(),
  getPool: vi.fn(),
  closePool: vi.fn(),
}));

const cashRow = vi.fn();
const openPrimaryCash = vi.fn(async () => true);
const recordPrimaryMovement = vi.fn(async () => 'recorded');
const setPrimaryCash = vi.fn(async () => 'set');

vi.mock('../src/db/queries.js', () => ({
  getSessionUser: vi.fn(async (userId: string) => (await import('./session.js')).mockedSessionUser(userId)),
  getUser: vi.fn(async () => USER),
  primaryAgentId: vi.fn(async () => PRIMARY),
  getPrimaryCash: () => cashRow(),
  sumFeesPaid: vi.fn(async () => 1_500),
  openPrimaryCash: (...args: unknown[]) => openPrimaryCash(...(args as [])),
  recordPrimaryMovement: (...args: unknown[]) => recordPrimaryMovement(...(args as [])),
  setPrimaryCash: (...args: unknown[]) => setPrimaryCash(...(args as [])),
  transaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({})),
  listHoldings: vi.fn(async () => [
    {
      id: 'h1',
      instrument_id: 'i1',
      symbol: 'AAPL',
      name: 'Apple',
      asset_class: 'equity',
      exchange: 'NMS',
      quantity: '10',
      cost_basis_minor: '15000',
      currency: 'USD',
      opened_at: null,
      notes: null,
    },
  ]),
}));

const { loadConfig, resetConfigForTests } = await import('../src/config.js');
const { createApp } = await import('../src/http/app.js');
const { createFakeAi } = await import('./fakeAi.js');
const { MAX_BUDGET_MINOR } = await import('../src/http/routes/agents.js');

const ENV = {
  APP_ENV: 'test',
  LOG_LEVEL: 'error',
  SESSION_SECRET: 'test-session-secret-value',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  AI_SERVICE_URL: 'http://ai-service:8000',
  INTERNAL_API_KEY: 'internal-test-key',
  ALLOWED_ORIGINS: 'http://localhost:5173',
} as unknown as NodeJS.ProcessEnv;

const ORIGIN = 'http://localhost:5173';
const OPEN_ROW = {
  budget_minor: '50000',
  opening_holdings_cost_minor: '150000',
  balance_minor: '42000',
  currency: 'USD',
  income_minor: '1230',
  charges_minor: '400',
};

describe('the real portfolio’s cash', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetConfigForTests();
    app = createApp(loadConfig(ENV), createFakeAi());
    cashRow.mockResolvedValue(OPEN_ROW);
  });

  const send = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { cookie: sessionCookie(), origin: ORIGIN, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it('is unset - not $0 - until the user sets it', async () => {
    cashRow.mockResolvedValue({ budget_minor: null, opening_holdings_cost_minor: null, balance_minor: null, currency: 'USD' });
    expect(await (await send('GET', '/portfolio/cash')).json()).toEqual({ state: 'unset' });
  });

  it('adds what was already invested to the deposits', async () => {
    expect(await (await send('GET', '/portfolio/cash')).json()).toEqual({
      state: 'open',
      currency: 'USD',
      cashMinor: 42_000,
      depositsMinor: 50_000,
      openingHoldingsCostMinor: 150_000,
      investedMinor: 200_000,
      feesPaidMinor: 1_500,
      incomeMinor: 1_230,
      chargesMinor: 400,
    });
  });

  it('opens with the cash typed and the holdings at cost, and only once', async () => {
    const response = await send('POST', '/portfolio/cash', { amount: '1250.50' });
    expect(response.status).toBe(201);
    // 10 AAPL at $150.00 a unit: $1,500.00 already invested.
    expect(openPrimaryCash).toHaveBeenCalledWith(USER.id, PRIMARY, 125_050, 150_000);

    openPrimaryCash.mockResolvedValueOnce(false);
    const again = await send('POST', '/portfolio/cash', { amount: '10' });
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe('cash_already_set');
  });

  it('opens with $0, a real answer, but refuses a $0 movement', async () => {
    expect((await send('POST', '/portfolio/cash', { amount: '0' })).status).toBe(201);
    const deposit = await send('POST', '/portfolio/cash/movements', { type: 'deposit', amount: '0' });
    expect(deposit.status).toBe(422);
    expect(recordPrimaryMovement).not.toHaveBeenCalled();
  });

  it('refuses an amount that is not dollars and cents, or a type it does not know', async () => {
    for (const amount of ['-5', '1.234', 'ten', '']) {
      expect((await send('POST', '/portfolio/cash/movements', { type: 'income', amount })).status, amount).toBe(400);
    }
    for (const type of ['top_up', 'adjustment', 'buy', undefined]) {
      expect((await send('POST', '/portfolio/cash/movements', { type, amount: '5' })).status, String(type)).toBe(400);
    }
    expect(recordPrimaryMovement).not.toHaveBeenCalled();
  });

  it('records each type of movement as the amount typed, always positive (D340)', async () => {
    for (const type of ['deposit', 'withdrawal', 'income', 'charge'] as const) {
      const response = await send('POST', '/portfolio/cash/movements', { type, amount: '12.30' });
      expect(response.status, type).toBe(201);
      expect(recordPrimaryMovement).toHaveBeenLastCalledWith({}, USER.id, PRIMARY, type, 1_230, MAX_BUDGET_MINOR);
    }
  });

  it('says why a movement was refused', async () => {
    for (const [outcome, status, error] of [
      ['unopened', 409, 'cash_not_set'],
      ['insufficient_cash', 422, 'insufficient_cash'],
      ['over_ceiling', 422, 'amount_out_of_range'],
    ] as const) {
      recordPrimaryMovement.mockResolvedValueOnce(outcome);
      const response = await send('POST', '/portfolio/cash/movements', { type: 'withdrawal', amount: '100' });
      expect(response.status, outcome).toBe(status);
      expect((await response.json()).error, outcome).toBe(error);
    }
  });

  it('sets the balance to what the broker shows, and asks for the cash first when it is unset', async () => {
    expect((await send('PUT', '/portfolio/cash', { amount: '420' })).status).toBe(200);
    expect(setPrimaryCash).toHaveBeenCalledWith({}, USER.id, PRIMARY, 42_000);

    setPrimaryCash.mockResolvedValueOnce('unopened');
    const unset = await send('PUT', '/portfolio/cash', { amount: '420' });
    expect(unset.status).toBe(409);
    expect((await unset.json()).error).toBe('cash_not_set');
  });
});
