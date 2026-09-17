/**
 * Target weights: validation, replace-not-patch semantics, and the fact that the
 * scan now sends the user's real targets.
 *
 * The database layer is mocked, as in app.test.ts: every rule tested here is a
 * decision this process makes before any SQL runs, and the one rule the database
 * does enforce (0 <= weight <= 1) is restated in the route precisely so a client
 * gets an error it can act on rather than a constraint violation.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = {
  id: '00000000-0000-0000-0000-000000000001',
  email: null,
  base_currency: 'USD',
  timezone: 'Asia/Jerusalem',
};

const holdingRow = {
  id: 'holding-1',
  user_id: USER.id,
  instrument_id: 'instrument-aapl',
  quantity: '10',
  cost_basis_minor: '18540',
  currency: 'USD',
  opened_at: null,
  notes: null,
  symbol: 'AAPL',
  name: 'Apple Inc.',
  asset_class: 'equity',
  exchange: 'TEST',
  instrument_currency: 'USD',
};

/** Instruments this installation has already resolved. VOO is known but unheld. */
const INSTRUMENTS: Record<string, { id: string; symbol: string; name: string }> = {
  AAPL: { id: 'instrument-aapl', symbol: 'AAPL', name: 'Apple Inc.' },
  VOO: { id: 'instrument-voo', symbol: 'VOO', name: 'Vanguard S&P 500 ETF' },
  'BTC-USD': { id: 'instrument-btc', symbol: 'BTC-USD', name: 'Bitcoin' },
};

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
  listHoldings: vi.fn(async () => [holdingRow]),
  listSnapshots: vi.fn(async () => []),
  recordQuotes: vi.fn(async () => undefined),
  getHolding: vi.fn(async () => holdingRow),
  upsertInstrument: vi.fn(async () => ({ id: 'instrument-aapl', symbol: 'AAPL' })),
  upsertHolding: vi.fn(async () => ({ id: 'holding-1', inserted: true })),
  updateHolding: vi.fn(async () => holdingRow),
  deleteHolding: vi.fn(async () => true),
  deleteAllHoldings: vi.fn(async () => 0),
  upsertSnapshot: vi.fn(async () => undefined),
  claimRun: vi.fn(async () => ({ claimed: true, runId: 'run-1' })),
  finishRun: vi.fn(async () => undefined),
  listRuns: vi.fn(async () => []),
  insertObservations: vi.fn(async () => ({ created: 0, suppressed: 0, inserted: [] })),
  getOrCreateUserSettings: vi.fn(async () => ({
    proposal_severity: 'high',
    proposal_ttl_hours: 24,
    notify_severity: 'high',
    quiet_hours_start: '22:00',
    quiet_hours_end: '07:00',
    muted_until: null,
  })),
  createProposals: vi.fn(async () => []),
  listObservations: vi.fn(async () => []),
  listRecentDedupeKeys: vi.fn(async () => []),
  listTargetWeights: vi.fn(async () => []),
  findInstrumentsBySymbols: vi.fn(async (symbols: string[]) =>
    symbols.map((symbol) => INSTRUMENTS[symbol.toUpperCase()]).filter(Boolean),
  ),
  replaceTargetWeights: vi.fn(async (_userId: string, targets: unknown[]) => targets.length),
  transaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({})),
}));

const { loadConfig, resetConfigForTests } = await import('../src/config.js');
const { createApp } = await import('../src/http/app.js');
const { MAX_TARGETS, WEIGHT_DECIMAL_PLACES } = await import('../src/http/routes/targets.js');
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

let ai: ReturnType<typeof createFakeAi>;

function buildApp() {
  resetConfigForTests();
  ai = createFakeAi();
  return createApp(loadConfig(ENV), ai);
}

async function loginCookie(app: ReturnType<typeof buildApp>): Promise<string> {
  const response = await app.request('/auth/login', {
    method: 'POST',
    headers: ORIGIN,
    body: JSON.stringify({ passphrase: 'test-passphrase' }),
  });
  const cookie = response.headers.get('set-cookie') as string;
  return cookie.split(';')[0]!;
}

async function putTargets(
  app: ReturnType<typeof buildApp>,
  cookie: string,
  targets: unknown,
): Promise<Response> {
  return app.request('/targets', {
    method: 'PUT',
    headers: { ...ORIGIN, cookie },
    body: JSON.stringify({ targets }),
  });
}

describe('target weights', () => {
  let app: ReturnType<typeof buildApp>;
  let cookie: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = buildApp();
    cookie = await loginCookie(app);
  });

  it('requires a session to read or write targets', async () => {
    expect((await app.request('/targets')).status).toBe(401);
    const write = await app.request('/targets', {
      method: 'PUT',
      headers: ORIGIN,
      body: JSON.stringify({ targets: [] }),
    });
    expect(write.status).toBe(401);
  });

  it('blocks a write from an unknown origin', async () => {
    const response = await app.request('/targets', {
      method: 'PUT',
      headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ targets: [] }),
    });
    expect(response.status).toBe(403);
  });

  it('serves the stored set with the weights exactly as the database holds them', async () => {
    vi.mocked(queries.listTargetWeights).mockResolvedValueOnce([
      { instrument_id: 'instrument-aapl', symbol: 'AAPL', name: 'Apple Inc.', weight: '0.2500' },
    ]);
    const response = await app.request('/targets', { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      targets: [{ symbol: 'AAPL', name: 'Apple Inc.', weight: '0.2500' }],
    });
  });

  it('replaces the whole set rather than patching it', async () => {
    const response = await putTargets(app, cookie, [
      { symbol: 'AAPL', weight: '0.4' },
      { symbol: 'VOO', weight: '0.6' },
    ]);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ count: 2, sum: '1.0000' });
    // The write receives every target in one call: the set is the unit, so no
    // intermediate state can exist in which only half of it has been applied.
    expect(queries.replaceTargetWeights).toHaveBeenCalledWith(USER.id, [
      { instrumentId: 'instrument-aapl', weight: '0.4' },
      { instrumentId: 'instrument-voo', weight: '0.6' },
    ]);
  });

  it('treats an empty set as clearing the targets, not as an error', async () => {
    const response = await putTargets(app, cookie, []);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ count: 0, targets: [] });
    expect(queries.replaceTargetWeights).toHaveBeenCalledWith(USER.id, []);
  });

  it('rejects a weight above 1', async () => {
    const response = await putTargets(app, cookie, [{ symbol: 'AAPL', weight: '1.5' }]);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: 'weight_out_of_range' });
    expect(queries.replaceTargetWeights).not.toHaveBeenCalled();
  });

  it('rejects a negative weight before it reaches the database', async () => {
    const response = await putTargets(app, cookie, [{ symbol: 'AAPL', weight: '-0.1' }]);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_body' });
  });

  it('rejects a set summing to more than the whole portfolio', async () => {
    const response = await putTargets(app, cookie, [
      { symbol: 'AAPL', weight: '0.7' },
      { symbol: 'VOO', weight: '0.4' },
    ]);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: 'weights_exceed_one', details: { sum: '1.1000' } });
    expect(queries.replaceTargetWeights).not.toHaveBeenCalled();
  });

  it('accepts a set summing to exactly 1', async () => {
    // Decided in integer arithmetic. These three are exactly one whole; summed
    // as floats they are not, and the user would be told their allocation is
    // impossible.
    const response = await putTargets(app, cookie, [
      { symbol: 'AAPL', weight: '0.1' },
      { symbol: 'VOO', weight: '0.2' },
      { symbol: 'BTC-USD', weight: '0.7' },
    ]);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sum: '1.0000' });
  });

  it('accepts a partial set that sums to less than 1', async () => {
    const response = await putTargets(app, cookie, [{ symbol: 'AAPL', weight: '0.25' }]);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sum: '0.2500' });
  });

  it('rejects a weight finer than the stored precision instead of rounding it', async () => {
    const tooPrecise = `0.${'1'.repeat(WEIGHT_DECIMAL_PLACES + 1)}`;
    const response = await putTargets(app, cookie, [{ symbol: 'AAPL', weight: tooPrecise }]);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_body' });
  });

  it('rejects a weight that is not a decimal string', async () => {
    const response = await putTargets(app, cookie, [{ symbol: 'AAPL', weight: 0.25 }]);
    expect(response.status).toBe(400);
  });

  it('rejects a set naming the same instrument twice', async () => {
    const response = await putTargets(app, cookie, [
      { symbol: 'AAPL', weight: '0.2' },
      { symbol: 'aapl', weight: '0.3' },
    ]);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: 'duplicate_symbol',
      details: { symbols: ['AAPL'] },
    });
  });

  it('rejects a symbol this portfolio has never resolved', async () => {
    const response = await putTargets(app, cookie, [{ symbol: 'NOSUCH', weight: '0.2' }]);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: 'unknown_symbol',
      details: { symbols: ['NOSUCH'] },
    });
    expect(queries.replaceTargetWeights).not.toHaveBeenCalled();
  });

  it('allows a target on a known instrument the user does not currently hold', async () => {
    // Only AAPL is held; VOO is a resolved instrument with no position. "I meant
    // to hold 20% of this and I hold none" is a statement about intent, and the
    // drift rule reports it as a real drift.
    const response = await putTargets(app, cookie, [{ symbol: 'VOO', weight: '0.2' }]);
    expect(response.status).toBe(200);
    expect(queries.replaceTargetWeights).toHaveBeenCalledWith(USER.id, [
      { instrumentId: 'instrument-voo', weight: '0.2' },
    ]);
  });

  it('refuses a set larger than the cap', async () => {
    const oversized = Array.from({ length: MAX_TARGETS + 1 }, () => ({
      symbol: 'AAPL',
      weight: '0.0001',
    }));
    const response = await putTargets(app, cookie, oversized);
    expect(response.status).toBe(400);
  });

  it('sends the stored targets to the analysis service instead of an empty set', async () => {
    vi.mocked(queries.listTargetWeights).mockResolvedValueOnce([
      { instrument_id: 'instrument-aapl', symbol: 'AAPL', name: 'Apple Inc.', weight: '0.2500' },
      { instrument_id: 'instrument-voo', symbol: 'VOO', name: 'Vanguard', weight: '0.7500' },
    ]);
    const scan = vi.spyOn(ai, 'portfolioScan');

    const response = await app.request('/internal/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': 'internal-test-key' },
      body: JSON.stringify({ kind: 'portfolio_scan' }),
    });
    expect(response.status).toBe(200);
    // Decimal strings, as stored: the weight is never a number on this side.
    expect(scan.mock.calls[0]![0]).toMatchObject({
      target_weights: { AAPL: '0.2500', VOO: '0.7500' },
    });
  });
});
