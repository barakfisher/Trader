/**
 * The three reads behind a holding's page: its chart, its news, its findings.
 *
 * What is worth pinning is ownership - every read goes through the user's own
 * holding row, so another user's holding (or an instrument id guessed into the
 * path) is a 404 and never reaches the AI service or the articles - and that a
 * holding's findings are found under both subject formats the rules write.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = {
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

const HOLDING_ID = 'f2c094ed-4c04-4c6e-8216-ddc55b8aeb6b';
const HOLDING_ROW = {
  id: HOLDING_ID,
  user_id: USER.id,
  instrument_id: 'a0000000-0000-0000-0000-00000000000a',
  quantity: '40',
  cost_basis_minor: '9875',
  currency: 'USD',
  opened_at: null,
  notes: null,
  symbol: 'NVDA',
  name: 'NVIDIA Corporation',
  asset_class: 'equity',
  exchange: 'NASDAQ',
  instrument_currency: 'USD',
};

const queries = vi.hoisted(() => ({
  getHolding: vi.fn(),
  listHoldingArticles: vi.fn(async (): Promise<unknown[]> => []),
  listObservations: vi.fn(async (): Promise<unknown[]> => []),
  getLatestFinishedRun: vi.fn(async (): Promise<unknown> => null),
}));

vi.mock('../src/db/queries.js', () => ({
  getUser: vi.fn(async () => USER),
  ...queries,
}));

const { loadConfig, resetConfigForTests } = await import('../src/config.js');
const { createApp } = await import('../src/http/app.js');
const { HOLDING_HISTORY_DAYS, HOLDING_NEWS_DAYS, HOLDING_NEWS_PAGE } =
  await import('../src/http/routes/holdings.js');
const { AiServiceError } = await import('@traders/shared/ai');

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

const priceHistory = vi.fn();

function buildApp() {
  resetConfigForTests();
  return createApp(loadConfig(ENV), { priceHistory } as never);
}

let app: ReturnType<typeof buildApp>;
let cookie: string;

beforeEach(async () => {
  vi.clearAllMocks();
  // Reset, not cleared: the 'not-a-uuid' case never reaches `getHolding`, and a
  // one-shot answer it leaves behind would be the next test's holding.
  queries.getHolding.mockReset();
  app = buildApp();
  const response = await app.request('/auth/login', {
    method: 'POST',
    headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' },
    body: JSON.stringify({ passphrase: 'test-passphrase' }),
  });
  cookie = (response.headers.get('set-cookie') as string).split(';')[0]!;
});

const get = (path: string) => app.request(path, { headers: { cookie } });

describe('GET /holdings/:id/history', () => {
  it("asks the AI service for the holding's instrument and passes its closes through", async () => {
    queries.getHolding.mockResolvedValueOnce(HOLDING_ROW);
    priceHistory.mockResolvedValueOnce({
      instrument_id: HOLDING_ROW.instrument_id,
      days: HOLDING_HISTORY_DAYS,
      closes: [
        { day: '2026-09-29', price_minor: 22721, currency: 'USD', as_of: '2026-09-29T20:00:00Z' },
      ],
    });

    const response = await get(`/holdings/${HOLDING_ID}/history`);

    expect(response.status).toBe(200);
    expect(queries.getHolding).toHaveBeenCalledWith(USER.id, HOLDING_ID);
    expect(priceHistory).toHaveBeenCalledWith(
      HOLDING_ROW.instrument_id,
      HOLDING_HISTORY_DAYS,
      expect.anything(),
    );
    expect(await response.json()).toEqual({
      holdingId: HOLDING_ID,
      symbol: 'NVDA',
      days: HOLDING_HISTORY_DAYS,
      closes: [
        { day: '2026-09-29', priceMinor: 22721, currency: 'USD', asOf: '2026-09-29T20:00:00.000Z' },
      ],
    });
  });

  it.each([HOLDING_ID, 'not-a-uuid'])(
    "is a 404 for a holding that is not the user's (%s), before the AI service is asked",
    async (id) => {
      queries.getHolding.mockResolvedValueOnce(null);
      expect((await get(`/holdings/${id}/history`)).status).toBe(404);
      expect(priceHistory).not.toHaveBeenCalled();
    },
  );

  it('reports an AI service failure as a gateway error, not as an empty chart', async () => {
    queries.getHolding.mockResolvedValueOnce(HOLDING_ROW);
    priceHistory.mockRejectedValueOnce(new AiServiceError('boom', 500));
    expect((await get(`/holdings/${HOLDING_ID}/history`)).status).toBe(502);
  });

  it('requires a session', async () => {
    expect((await app.request(`/holdings/${HOLDING_ID}/history`)).status).toBe(401);
  });
});

describe('GET /holdings/:id/news', () => {
  const ARTICLE = {
    id: 'art-1',
    url: 'https://example.com/nvda',
    source: 'example.com',
    title: 'Nvidia ships a chip',
    published_at: new Date('2026-09-29T08:00:00Z'),
    fetched_at: new Date('2026-09-29T08:15:00Z'),
    instruments: [
      { symbol: 'NVDA', match_method: 'company_name', matched_text: 'Nvidia', salience: '0.9000' },
    ],
    sentiment: null,
    total: '331',
  };

  it('returns a page of the week with the total, so a page never reads as the whole week', async () => {
    queries.getHolding.mockResolvedValueOnce(HOLDING_ROW);
    queries.listHoldingArticles.mockResolvedValueOnce([ARTICLE]);

    const body = await (await get(`/holdings/${HOLDING_ID}/news`)).json();

    expect(queries.listHoldingArticles).toHaveBeenCalledWith(
      USER.id,
      HOLDING_ID,
      HOLDING_NEWS_DAYS,
      HOLDING_NEWS_PAGE,
    );
    expect(body).toMatchObject({ holdingId: HOLDING_ID, symbol: 'NVDA', total: 331 });
    expect(body.articles[0]).toEqual({
      id: 'art-1',
      url: 'https://example.com/nvda',
      source: 'example.com',
      title: 'Nvidia ships a chip',
      publishedAt: '2026-09-29T08:00:00.000Z',
      fetchedAt: '2026-09-29T08:15:00.000Z',
      instruments: [
        { symbol: 'NVDA', matchMethod: 'company_name', matchedText: 'Nvidia', salience: '0.9000' },
      ],
      sentiment: null,
    });
  });

  it('says which empty an empty week is', async () => {
    queries.getHolding.mockResolvedValueOnce(HOLDING_ROW);
    queries.getLatestFinishedRun.mockResolvedValueOnce({
      started_at: new Date('2026-09-30T06:00:00Z'),
      status: 'degraded',
      stats: { provider_failures: ['gdelt'] },
    });

    const body = await (await get(`/holdings/${HOLDING_ID}/news`)).json();

    expect(body.total).toBe(0);
    expect(body.collection).toEqual({
      lastRunAt: '2026-09-30T06:00:00.000Z',
      status: 'degraded',
      failedProviders: ['gdelt'],
    });
  });

  it("is a 404 for a holding that is not the user's", async () => {
    queries.getHolding.mockResolvedValueOnce(null);
    expect((await get(`/holdings/${HOLDING_ID}/news`)).status).toBe(404);
    expect(queries.listHoldingArticles).not.toHaveBeenCalled();
  });
});

describe('GET /observations?symbol=', () => {
  it('asks for both subject formats a finding about the symbol is stored under', async () => {
    await get('/observations?symbol=nvda');
    expect(queries.listObservations).toHaveBeenCalledWith(USER.id, 50, [
      'instrument:NVDA',
      'portfolio:allocation:NVDA',
    ]);
  });

  it('without a symbol, is the whole feed', async () => {
    await get('/observations');
    expect(queries.listObservations).toHaveBeenCalledWith(USER.id, 50, null);
  });
});
