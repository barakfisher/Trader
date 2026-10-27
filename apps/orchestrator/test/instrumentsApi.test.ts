/**
 * Symbol lookup for the add-holding form (D324, D325): the local directory sent
 * whole with an ETag, the provider search behind it, and the latest price to
 * prefill a cost - null, never zero, when there is none.
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

vi.mock('../src/db/pool.js', () => ({
  queryOne: vi.fn(async () => ({ ok: 1 })),
  query: vi.fn(async () => []),
  transaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({})),
  initPool: vi.fn(),
  getPool: vi.fn(),
  closePool: vi.fn(),
}));

const directory = vi.fn(async () => [
  { symbol: 'AAPL', name: 'Apple Inc.', asset_class: 'equity', exchange: 'NMS' },
  { symbol: 'SPY', name: 'SPDR S&P 500 ETF Trust', asset_class: 'etf', exchange: 'PCX' },
]);

vi.mock('../src/db/queries.js', () => ({
  getSessionUser: vi.fn(async (userId: string) => (await import('./session.js')).mockedSessionUser(userId)),
  getUser: vi.fn(async () => USER),
  listInstrumentDirectory: () => directory(),
}));

const { loadConfig, resetConfigForTests } = await import('../src/config.js');
const { createApp } = await import('../src/http/app.js');
const { createFakeAi } = await import('./fakeAi.js');

const ENV = {
  APP_ENV: 'test',
  LOG_LEVEL: 'error',
  SESSION_SECRET: 'test-session-secret-value',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  AI_SERVICE_URL: 'http://ai-service:8000',
  INTERNAL_API_KEY: 'internal-test-key',
  ALLOWED_ORIGINS: 'http://localhost:5173',
} as unknown as NodeJS.ProcessEnv;

describe('the instrument lookup API', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetConfigForTests();
    app = createApp(loadConfig(ENV), createFakeAi({ unpriceable: ['MSFT'] }));
  });

  it('refuses every lookup without a session', async () => {
    for (const path of ['/instruments', '/instruments/search?q=aa', '/instruments/AAPL/quote']) {
      expect((await app.request(path)).status).toBe(401);
    }
  });

  it('sends the directory with an ETag, then a 304 while it is unchanged', async () => {
    const cookie = sessionCookie();
    const first = await app.request('/instruments', { headers: { cookie } });
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('private, no-cache');
    const tag = first.headers.get('etag');
    expect(tag).toBeTruthy();
    expect((await first.json()).instruments[0]).toEqual({
      symbol: 'AAPL',
      name: 'Apple Inc.',
      assetClass: 'equity',
      exchange: 'NMS',
    });

    const again = await app.request('/instruments', { headers: { cookie, 'if-none-match': tag! } });
    expect(again.status).toBe(304);

    directory.mockResolvedValueOnce([]);
    const changed = await app.request('/instruments', { headers: { cookie, 'if-none-match': tag! } });
    expect(changed.status).toBe(200);
  });

  it('passes a search to the provider and maps its matches', async () => {
    const cookie = sessionCookie();
    const response = await app.request('/instruments/search?q=aa', { headers: { cookie } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.query).toBe('aa');
    expect(body.matches).toContainEqual({ symbol: 'AAPL', name: 'AAPL', assetClass: 'equity', exchange: 'TEST' });
  });

  it('refuses a blank or overlong search', async () => {
    const cookie = sessionCookie();
    expect((await app.request('/instruments/search?q=%20', { headers: { cookie } })).status).toBe(400);
    const long = 'a'.repeat(65);
    expect((await app.request(`/instruments/search?q=${long}`, { headers: { cookie } })).status).toBe(400);
  });

  it('gives the latest price, and null - never zero - when there is none', async () => {
    const cookie = sessionCookie();
    const priced = await (await app.request('/instruments/aapl/quote', { headers: { cookie } })).json();
    expect(priced.symbol).toBe('AAPL');
    expect(priced.priceMinor).toBeGreaterThan(0);
    expect(priced.currency).toBe('USD');

    const unpriced = await (await app.request('/instruments/MSFT/quote', { headers: { cookie } })).json();
    expect(unpriced).toEqual({ symbol: 'MSFT', priceMinor: null, currency: null, asOf: null });
  });

  it('refuses a path that is not a symbol', async () => {
    const cookie = sessionCookie();
    expect((await app.request('/instruments/a%20b/quote', { headers: { cookie } })).status).toBe(400);
  });
});
