/**
 * Manual trades (Stage 3, PR 4): every rule `services/fills.ts` applies, and the
 * routes that reach it.
 *
 * The database layer is an in-memory ledger whose `insertFill` moves cash the
 * way migration 0040's triggers do, so these tests are about the decisions this
 * process makes - what is refused, at what price, with what fee. The SQL and the
 * triggers are proven against Postgres in test_ledger_sql.py and
 * queries.postgres.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MIN_FEE_MINOR } from '@traders/shared';

const USER = {
  id: '00000000-0000-0000-0000-000000000001',
  email: null,
  base_currency: 'USD',
  timezone: 'Asia/Jerusalem',
};
const PRIMARY = '90000000-0000-0000-0000-000000000001';
const AGENT = '90000000-0000-0000-0000-0000000000a1';
const NOW = new Date('2026-10-05T16:00:00Z');

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
    holdings_count: 0,
    ...overrides,
  };
}

const INSTRUMENTS: Record<string, Record<string, unknown>> = {
  AAPL: { id: 'i-aapl', symbol: 'AAPL', name: 'Apple', asset_class: 'equity', exchange: 'NMS', currency: 'USD', membership: 'screened' },
  BTC: { id: 'i-btc', symbol: 'BTC-USD', name: 'Bitcoin', asset_class: 'crypto', exchange: 'CCC', currency: 'USD', membership: null },
  SAP: { id: 'i-sap', symbol: 'SAP.DE', name: 'SAP', asset_class: 'equity', exchange: 'XETRA', currency: 'EUR', membership: 'screened' },
  GONE: { id: 'i-gone', symbol: 'GONE', name: 'Delisted', asset_class: 'equity', exchange: 'NYQ', currency: 'USD', membership: 'dropped' },
};

interface Ledger {
  cash: bigint;
  holdings: Map<string, { quantity: string; cost_basis_minor: string }>;
  fills: Record<string, unknown>[];
}
const ledger: Ledger = { cash: 0n, holdings: new Map(), fills: [] };

vi.mock('../src/db/pool.js', () => ({
  queryOne: vi.fn(async () => ({ ok: 1 })),
  query: vi.fn(async () => []),
  transaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({})),
  initPool: vi.fn(),
  getPool: vi.fn(),
  closePool: vi.fn(),
}));

vi.mock('../src/db/queries.js', () => ({
  transaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({})),
  getUser: vi.fn(async () => USER),
  getAgent: vi.fn(async (_u: string, id: string) =>
    id === PRIMARY ? agentRow({ id: PRIMARY, is_primary: true, budget_minor: null }) : id === AGENT ? agentRow() : null,
  ),
  findTradableInstrument: vi.fn(async (symbol: string) =>
    Object.values(INSTRUMENTS).find((row) => row.symbol === symbol.trim().toUpperCase()) ?? null,
  ),
  getAgentCash: vi.fn(async () => ({ balance_minor: ledger.cash.toString(), currency: 'USD', updated_at: NOW })),
  lockAgentCash: vi.fn(async () => ledger.cash),
  getAgentHoldingQuantity: vi.fn(async (_u: string, _a: string, instrumentId: string) =>
    ledger.holdings.get(instrumentId)?.quantity ?? null,
  ),
  lockAgentHolding: vi.fn(async (_c: unknown, _u: string, _a: string, instrumentId: string) =>
    ledger.holdings.get(instrumentId) ?? null,
  ),
  findFillByKey: vi.fn(async (_u: string, _a: string, key: string) =>
    ledger.fills.find((fill) => fill.idempotency_key === key) ?? null,
  ),
  listFills: vi.fn(async () => [...ledger.fills].reverse()),
  // What migration 0040's triggers do: the fill moves cash by its own effect.
  insertFill: vi.fn(async (_c: unknown, fill: Record<string, unknown>) => {
    const notional = fill.notionalMinor as bigint;
    const fee = fill.feeMinor as bigint;
    ledger.cash += fill.side === 'buy' ? -(notional + fee) : notional - fee;
    const id = `fill-${ledger.fills.length + 1}`;
    ledger.fills.push({
      id,
      agent_id: fill.agentId,
      instrument_id: fill.instrumentId,
      symbol: Object.values(INSTRUMENTS).find((row) => row.id === fill.instrumentId)!.symbol,
      side: fill.side,
      quantity: `${fill.quantity}.000000000000000000`,
      price_minor: String(fill.priceMinor),
      notional_minor: String(notional),
      fee_minor: String(fee),
      currency: 'USD',
      price_source: fill.priceSource,
      quote_as_of: fill.quoteAsOf ? new Date(fill.quoteAsOf as string) : null,
      quote_delay_seconds: fill.quoteDelaySeconds,
      source: fill.source,
      proposal_id: fill.proposalId,
      idempotency_key: fill.idempotencyKey,
      created_at: NOW,
    });
    return id;
  }),
  setAgentHolding: vi.fn(async (_c: unknown, holding: Record<string, unknown>) => {
    const instrumentId = holding.instrumentId as string;
    if (holding.quantity === 0n) ledger.holdings.delete(instrumentId);
    else
      ledger.holdings.set(instrumentId, {
        quantity: `${holding.quantity}.000000000000000000`,
        cost_basis_minor: String(holding.costBasisMinor),
      });
  }),
}));

interface StubOptions {
  open?: boolean;
  priceMinor?: number;
  asOf?: () => string;
  stale?: boolean;
  calendarStatus?: number;
}

const { AiServiceError } = await import('@traders/shared/ai');

function stubAi(options: StubOptions = {}) {
  const asOf = options.asOf ?? (() => new Date(Date.now() - 15 * 60 * 1000).toISOString());
  return {
    marketCalendar: vi.fn(async (exchange: string) => {
      if (options.calendarStatus) throw new AiServiceError('calendar', options.calendarStatus);
      return {
        exchange,
        calendar: 'XNYS',
        as_of: NOW.toISOString(),
        is_open: options.open ?? true,
        session_closes_at: null,
        early_close: false,
        next_open: '2026-10-06T13:30:00Z',
        covered_until: '2030-12-31',
      };
    }),
    quotes: vi.fn(async (symbols: string[]) => ({
      quotes: symbols.map((symbol) => ({
        symbol,
        price_minor: options.priceMinor ?? 20_000,
        currency: 'USD',
        as_of: asOf(),
        source: 'fake',
        delay_seconds: 900,
        previous_close_minor: null,
        day_change_pct: null,
        stale: options.stale ?? false,
      })),
    })),
  };
}

const fills = await import('../src/services/fills.js');
const queries = await import('../src/db/queries.js');
type AiClient = import('@traders/shared/ai').AiClient;

function context(options: StubOptions = {}) {
  return {
    ai: stubAi(options) as unknown as AiClient,
    timezone: USER.timezone,
    now: () => NOW,
  };
}

function request(overrides: Partial<import('../src/services/fills.js').TradeRequest> = {}) {
  return {
    userId: USER.id,
    agent: agentRow() as never,
    symbol: 'AAPL',
    side: 'buy' as const,
    quantity: '3',
    price: { source: 'quote' as const, shownPriceMinor: 20_000n },
    source: 'manual_user_override' as const,
    idempotencyKey: 'key-1',
    ...overrides,
  };
}

/** A quote observed `minutes` before NOW. */
const minutesBefore = (minutes: number) => () => new Date(NOW.getTime() - minutes * 60_000).toISOString();

async function refusal(promise: Promise<unknown>): Promise<{ status: number; code: string; details?: unknown }> {
  try {
    await promise;
  } catch (error) {
    const problem = error as { status: number; code: string; details?: unknown };
    return { status: problem.status, code: problem.code, details: problem.details };
  }
  throw new Error('expected a refusal');
}

beforeEach(() => {
  vi.clearAllMocks();
  ledger.cash = 100_000n;
  ledger.holdings.clear();
  ledger.fills.length = 0;
});

describe('the price rules', () => {
  it('accepts a live price within the range either way, and refuses beyond it', () => {
    const shown = 20_000n;
    const edge = (shown * fills.DEFAULT_RANGE_BPS) / fills.BPS;
    expect(fills.withinRange(shown, shown + edge)).toBe(true);
    expect(fills.withinRange(shown, shown - edge)).toBe(true);
    expect(fills.withinRange(shown, shown + edge + 1n)).toBe(false);
    expect(fills.withinRange(shown, shown - edge - 1n)).toBe(false);
  });

  it('treats a quote as fresh up to the limit, and never when stale', () => {
    const at = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
    expect(fills.quoteIsFresh({ as_of: at(fills.MAX_QUOTE_AGE_MS), stale: false }, NOW)).toBe(true);
    expect(fills.quoteIsFresh({ as_of: at(fills.MAX_QUOTE_AGE_MS + 1), stale: false }, NOW)).toBe(false);
    expect(fills.quoteIsFresh({ as_of: at(0), stale: true }, NOW)).toBe(false);
    expect(fills.quoteIsFresh({ as_of: 'not a date', stale: false }, NOW)).toBe(false);
  });

  it('averages cost per unit, rounding half up once', () => {
    expect(fills.averageCostMinor(0n, 0n, 3n, 20_000n)).toBe(20_000n);
    expect(fills.averageCostMinor(1n, 100n, 2n, 101n)).toBe(101n); // 302/3 = 100.67
    expect(fills.averageCostMinor(1n, 100n, 1n, 101n)).toBe(101n); // 100.5 rounds up
  });

  it('parses whole quantities and two-decimal prices, refusing anything else', () => {
    expect(fills.parseQuantity(' 12 ')).toBe(12n);
    for (const bad of ['0', '1.5', '-1', '01', 'ten', '12345678901']) {
      expect(() => fills.parseQuantity(bad)).toThrow();
    }
    expect(fills.parseTypedPrice('231.4')).toBe(23_140n);
    expect(fills.parseTypedPrice('5')).toBe(500n);
    for (const bad of ['0', '0.00', '1.234', '-3', 'abc', '1000000000.01']) {
      expect(() => fills.parseTypedPrice(bad)).toThrow();
    }
  });
});

describe('who and what may be traded', () => {
  it('never trades the real portfolio (D1) or an archived agent (D30); a paused one may', async () => {
    const primary = request({ agent: agentRow({ id: PRIMARY, is_primary: true }) as never });
    expect(await refusal(fills.executeFill(primary, context()))).toMatchObject({
      status: 409,
      code: 'primary_agent_is_passive',
    });
    const archived = request({ agent: agentRow({ state: 'archived' }) as never });
    expect(await refusal(fills.executeFill(archived, context()))).toMatchObject({ code: 'agent_archived' });
    const paused = request({ agent: agentRow({ state: 'paused' }) as never });
    expect((await fills.executeFill(paused, context())).created).toBe(true);
  });

  it('refuses what is outside the universe, dropped from it, or not in USD (D7, D8)', async () => {
    for (const [symbol, reason] of [
      ['BTC-USD', 'outside_universe'],
      ['GONE', 'outside_universe'],
      ['SAP.DE', 'not_usd'],
    ]) {
      expect(await refusal(fills.executeFill(request({ symbol }), context()))).toMatchObject({
        status: 422,
        code: 'not_tradable',
        details: { reason },
      });
    }
    expect(await refusal(fills.executeFill(request({ symbol: 'NOPE' }), context()))).toMatchObject({
      status: 404,
    });
    expect(queries.insertFill).not.toHaveBeenCalled();
  });
});

describe('a trade at the live price', () => {
  it('fills at the quote, charges the fee, moves cash and opens the holding', async () => {
    const result = await fills.executeFill(request(), context());
    expect(result.created).toBe(true);
    expect(result.fill).toMatchObject({
      symbol: 'AAPL',
      side: 'buy',
      quantity: '3',
      priceMinor: 20_000,
      notionalMinor: 60_000,
      feeMinor: Number(MIN_FEE_MINOR),
      priceSource: 'quote',
      quoteDelaySeconds: 900,
      source: 'manual_user_override',
    });
    expect(result.cashMinor).toBe(100_000 - 60_000 - Number(MIN_FEE_MINOR));
    expect(ledger.cash).toBe(BigInt(result.cashMinor));
    expect(result.heldQuantity).toBe('3');
    expect(ledger.holdings.get('i-aapl')).toMatchObject({ cost_basis_minor: '20000' });
  });

  it('refuses while the exchange is closed, naming the next open (D21, D25)', async () => {
    expect(await refusal(fills.executeFill(request(), context({ open: false })))).toMatchObject({
      status: 422,
      code: 'market_closed',
      details: { nextOpen: '2026-10-06T13:30:00Z' },
    });
  });

  it('refuses an exchange with no calendar as untradable', async () => {
    expect(await refusal(fills.executeFill(request(), context({ calendarStatus: 422 })))).toMatchObject({
      code: 'not_tradable',
      details: { reason: 'no_calendar' },
    });
  });

  it('refuses a quote older than the limit, or stale (D28)', async () => {
    const old = context({ asOf: minutesBefore(fills.MAX_QUOTE_AGE_MS / 60_000 + 1) });
    expect(await refusal(fills.executeFill(request(), old))).toMatchObject({ code: 'quote_too_old' });
    expect(await refusal(fills.executeFill(request(), context({ stale: true })))).toMatchObject({
      code: 'quote_too_old',
    });
  });

  it('refuses when the price moved beyond the range since it was shown, with the new price (D27)', async () => {
    const moved = 20_000 + Number((20_000n * fills.DEFAULT_RANGE_BPS) / fills.BPS) + 1;
    expect(await refusal(fills.executeFill(request(), context({ priceMinor: moved })))).toMatchObject({
      status: 409,
      code: 'price_moved',
      details: { shownPriceMinor: 20_000, livePriceMinor: moved },
    });
    expect(ledger.fills).toHaveLength(0);
  });

  it('requires the shown price when confirming', async () => {
    const unshown = request({ price: { source: 'quote', shownPriceMinor: null } });
    expect(await refusal(fills.executeFill(unshown, context()))).toMatchObject({ code: 'shown_price_required' });
  });
});

describe('a trade at a typed price (D21, D29)', () => {
  it('fills at the typed price whatever the market, flagged as typed', async () => {
    const typed = request({ price: { source: 'user', priceMinor: 19_000n } });
    const result = await fills.executeFill(typed, context({ open: false }));
    expect(result.fill).toMatchObject({ priceMinor: 19_000, priceSource: 'user', quoteAsOf: null });
  });

  it('warns, without refusing, when the typed price is far from the last known one', async () => {
    const far = request({ price: { source: 'user', priceMinor: 30_000n } });
    const preview = await fills.previewTrade(far, context());
    expect(preview.warnings).toEqual([
      expect.objectContaining({ kind: 'typed_price_far_from_quote', deviationBps: 5_000, referencePriceMinor: 20_000 }),
    ]);
    const near = request({ price: { source: 'user', priceMinor: 20_100n } });
    expect((await fills.previewTrade(near, context())).warnings).toEqual([]);
  });
});

describe('what does not fit is refused, never resized', () => {
  it('refuses a buy beyond cash and fee', async () => {
    ledger.cash = 60_000n; // the notional alone; the fee does not fit
    expect(await refusal(fills.executeFill(request(), context()))).toMatchObject({
      code: 'insufficient_cash',
      details: { cashMinor: 60_000, requiredMinor: 60_000 + Number(MIN_FEE_MINOR) },
    });
    expect(ledger.fills).toHaveLength(0);
  });

  it('refuses selling more than is held, and sells to zero by removing the holding', async () => {
    await fills.executeFill(request(), context());
    const tooMany = request({ side: 'sell', quantity: '4', idempotencyKey: 'sell-4' });
    expect(await refusal(fills.executeFill(tooMany, context()))).toMatchObject({
      code: 'insufficient_holding',
      details: { heldQuantity: '3' },
    });
    const all = await fills.executeFill(request({ side: 'sell', idempotencyKey: 'sell-3' }), context());
    expect(all.heldQuantity).toBe('0');
    expect(ledger.holdings.has('i-aapl')).toBe(false);
    expect(all.cashMinor).toBe(100_000 - 2 * Number(MIN_FEE_MINOR));
  });

  it('keeps the cost per unit on a sell, and averages it on a second buy', async () => {
    await fills.executeFill(request(), context());
    await fills.executeFill(request({ quantity: '1', idempotencyKey: 'k2', price: { source: 'user', priceMinor: 24_000n } }), context());
    expect(ledger.holdings.get('i-aapl')).toMatchObject({ quantity: '4.000000000000000000', cost_basis_minor: '21000' });
    await fills.executeFill(request({ side: 'sell', quantity: '2', idempotencyKey: 'k3' }), context());
    expect(ledger.holdings.get('i-aapl')).toMatchObject({ quantity: '2.000000000000000000', cost_basis_minor: '21000' });
  });
});

describe('one key, one fill (guideline 8)', () => {
  it('returns the existing fill for a repeated key, without fetching a price or writing', async () => {
    const first = await fills.executeFill(request(), context());
    const ai = context();
    const again = await fills.executeFill(request(), ai);
    expect(again.created).toBe(false);
    expect(again.fill.id).toBe(first.fill.id);
    expect(ledger.fills).toHaveLength(1);
    expect((ai.ai as unknown as { quotes: ReturnType<typeof vi.fn> }).quotes).not.toHaveBeenCalled();
  });
});

describe('the preview', () => {
  it('computes exactly what the trade would, and writes nothing', async () => {
    const preview = await fills.previewTrade(
      request({ price: { source: 'quote', shownPriceMinor: null } }),
      context(),
    );
    expect(preview).toMatchObject({
      priceMinor: 20_000,
      priceSource: 'quote',
      notionalMinor: 60_000,
      feeMinor: Number(MIN_FEE_MINOR),
      cashChangeMinor: -(60_000 + Number(MIN_FEE_MINOR)),
      cashMinor: 100_000,
      cashAfterMinor: 100_000 - 60_000 - Number(MIN_FEE_MINOR),
      heldQuantity: '0',
      heldAfterQuantity: '3',
      quoteDelaySeconds: 900,
    });
    expect(queries.insertFill).not.toHaveBeenCalled();
  });
});

describe('the trades routes', async () => {
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

  async function signedIn() {
    resetConfigForTests();
    const app = createApp(loadConfig(ENV), stubAi() as unknown as AiClient);
    const login = await app.request('/auth/login', {
      method: 'POST',
      headers: ORIGIN,
      body: JSON.stringify({ passphrase: 'test-passphrase' }),
    });
    const cookie = (login.headers.get('set-cookie') as string).split(';')[0]!;
    return (method: string, path: string, body?: unknown) =>
      app.request(path, {
        method,
        headers: { ...ORIGIN, cookie },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
  }

  it('previews, trades with a 201, and answers a repeated key with the same fill and a 200', async () => {
    const send = await signedIn();
    const preview = await send('POST', `/agents/${AGENT}/trades/preview`, { symbol: 'aapl', side: 'buy', quantity: '3' });
    expect(preview.status).toBe(200);
    const shown = (await preview.json()).priceMinor as number;
    const body = { symbol: 'AAPL', side: 'buy', quantity: '3', shownPriceMinor: shown, idempotencyKey: 'form-1' };
    const first = await send('POST', `/agents/${AGENT}/trades`, body);
    expect(first.status).toBe(201);
    const again = await send('POST', `/agents/${AGENT}/trades`, body);
    expect(again.status).toBe(200);
    expect((await again.json()).fill.id).toBe((await first.json()).fill.id);
    const listed = await send('GET', `/agents/${AGENT}/fills`);
    expect((await listed.json()).fills).toHaveLength(1);
  });

  it('refuses an unknown field, a bad price and an unknown agent', async () => {
    const send = await signedIn();
    expect((await send('POST', `/agents/${AGENT}/trades`, { symbol: 'AAPL', side: 'buy', quantity: '1', limit: 5 })).status).toBe(400);
    expect((await send('POST', `/agents/${AGENT}/trades`, { symbol: 'AAPL', side: 'buy', quantity: '1', price: '1.234' })).status).toBe(422);
    expect((await send('POST', '/agents/90000000-0000-0000-0000-0000000000ff/trades', { symbol: 'AAPL', side: 'buy', quantity: '1' })).status).toBe(404);
  });

  it('is behind a session like every route', async () => {
    resetConfigForTests();
    const app = createApp(loadConfig(ENV), stubAi() as unknown as AiClient);
    const response = await app.request(`/agents/${AGENT}/trades`, {
      method: 'POST',
      headers: ORIGIN,
      body: JSON.stringify({ symbol: 'AAPL', side: 'buy', quantity: '1' }),
    });
    expect(response.status).toBe(401);
  });
});
