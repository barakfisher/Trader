/**
 * The taxonomy API (D155): the rows `universe_taxonomy` holds, grouped into what
 * the "Sectors & industries" picker renders. The database layer is mocked; the
 * SQL runs against Postgres in queries.postgres.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = {
  id: '00000000-0000-0000-0000-000000000001',
  email: null,
  base_currency: 'USD',
  timezone: 'Asia/Jerusalem',
};
const OLDER = new Date('2026-10-01T00:00:00Z');
const NEWER = new Date('2026-10-18T00:00:00Z');

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
    { kind: 'industry', name: 'Semiconductors', sector: 'Technology', instruments: 38, updated_at: OLDER },
    { kind: 'etf_category', name: 'Technology', sector: 'Technology', instruments: 97, updated_at: OLDER },
    { kind: 'industry', name: 'Software - Application', sector: 'Technology', instruments: 120, updated_at: NEWER },
    { kind: 'industry', name: 'Uranium', sector: 'Energy', instruments: 9, updated_at: OLDER },
    { kind: 'etf_category', name: 'Large Blend', sector: null, instruments: 207, updated_at: OLDER },
  ]),
}));

const { loadConfig, resetConfigForTests } = await import('../src/config.js');
const { createApp } = await import('../src/http/app.js');
const { groupTaxonomy } = await import('../src/http/routes/taxonomy.js');
const { createFakeAi } = await import('./fakeAi.js');

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

describe('the taxonomy API', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetConfigForTests();
    app = createApp(loadConfig(ENV), createFakeAi());
  });

  it('refuses a request with no session', async () => {
    const response = await app.request('/universe/taxonomy', { headers: ORIGIN });
    expect(response.status).toBe(401);
  });

  it('groups industries and sector ETF categories under their sector', async () => {
    const login = await app.request('/auth/login', {
      method: 'POST',
      headers: ORIGIN,
      body: JSON.stringify({ passphrase: 'test-passphrase' }),
    });
    const cookie = (login.headers.get('set-cookie') as string).split(';')[0]!;
    const response = await app.request('/universe/taxonomy', { headers: { ...ORIGIN, cookie } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.sectors.map((sector: { name: string }) => sector.name)).toEqual(['Energy', 'Technology']);
    expect(body.sectors[1]).toEqual({
      name: 'Technology',
      instruments: 38 + 97 + 120,
      industries: [
        { name: 'Semiconductors', instruments: 38 },
        { name: 'Software - Application', instruments: 120 },
      ],
      etfCategories: [{ name: 'Technology', instruments: 97 }],
    });
    expect(body.etfCategories).toEqual([{ name: 'Large Blend', instruments: 207 }]);
    expect(body.updatedAt).toBe(NEWER.toISOString());
  });
});

describe('groupTaxonomy', () => {
  it('answers an empty table with nothing to offer, not an error', () => {
    expect(groupTaxonomy([])).toEqual({ sectors: [], etfCategories: [], updatedAt: null });
  });
});
