/**
 * Every `/admin/*` route answers 401 without a session and 403 for a session
 * whose user is not an admin (M8's first exit condition).
 *
 * The routes are read from the app itself, not listed here: a list in a test is
 * one more thing to forget, and the failure it exists to catch is precisely a
 * route somebody added without thinking about the guard. If the enumeration
 * finds nothing, the test fails rather than passing over an empty set.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const ADMIN = {
  id: '00000000-0000-0000-0000-000000000001',
  email: null,
  base_currency: 'USD',
  timezone: 'Asia/Jerusalem',
  role: 'admin',
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
  getUser: vi.fn(async () => ADMIN),
  // Read by the session (its language), at sign-in.
  getOrCreateUserSettings: vi.fn(async () => ({ language: 'en' })),
  listAllRuns: vi.fn(async () => []),
  listAdminAudit: vi.fn(async () => []),
  insertAdminAudit: vi.fn(async () => undefined),
  listOpsEvents: vi.fn(async () => []),
  getLatestUniverseLoad: vi.fn(async () => null),
  countUniverse: vi.fn(async () => ({ profiles: 0, equities: 0, etfs: 0, embedded: 0, etf_holdings: 0 })),
  firstLlmCallAt: vi.fn(async () => null),
  groupLlmCalls: vi.fn(async () => []),
  llmLatencies: vi.fn(async () => []),
  countNarrationFallbacks: vi.fn(async () => []),
  listLlmCalls: vi.fn(async () => []),
}));

const { loadConfig, resetConfigForTests } = await import('../src/config.js');
const { createApp, isAdminPath } = await import('../src/http/app.js');
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

const ORIGIN = 'http://localhost:5173';

function buildApp() {
  resetConfigForTests();
  return createApp(loadConfig(ENV), createFakeAi());
}

type App = ReturnType<typeof buildApp>;

/** Every concrete admin route: method and path, parameters filled in. */
function adminRoutes(app: App): { method: string; path: string }[] {
  const seen = new Set<string>();
  const routes: { method: string; path: string }[] = [];
  for (const route of app.routes) {
    // Middleware registers as ALL on '*'; only handlers name a real path.
    if (route.method === 'ALL' || !isAdminPath(route.path)) continue;
    const path = route.path.replace(/:[A-Za-z]+/g, 'x');
    const key = `${route.method} ${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push({ method: route.method, path });
  }
  return routes;
}

async function sessionCookie(app: App): Promise<string> {
  const response = await app.request('/auth/login', {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ passphrase: 'test-passphrase' }),
  });
  expect(response.status).toBe(200);
  return (response.headers.get('set-cookie') as string).split(';')[0]!;
}

function call(app: App, route: { method: string; path: string }, cookie?: string) {
  const headers: Record<string, string> = { origin: ORIGIN, 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  const hasBody = route.method !== 'GET' && route.method !== 'HEAD';
  return app.request(route.path, {
    method: route.method,
    headers,
    body: hasBody ? '{}' : undefined,
  });
}

describe('the admin guard', () => {
  let app: App;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queries.getUser).mockResolvedValue(ADMIN as never);
    app = buildApp();
  });

  it('finds admin routes to check', () => {
    expect(adminRoutes(app).length).toBeGreaterThan(0);
  });

  it('answers 401 on every admin route without a session', async () => {
    for (const route of adminRoutes(app)) {
      const response = await call(app, route);
      expect(response.status, `${route.method} ${route.path}`).toBe(401);
    }
  });

  it('answers 403 on every admin route for a signed-in user who is not an admin', async () => {
    const cookie = await sessionCookie(app);
    vi.mocked(queries.getUser).mockResolvedValue({ ...ADMIN, role: 'user' } as never);
    for (const route of adminRoutes(app)) {
      const response = await call(app, route, cookie);
      expect(response.status, `${route.method} ${route.path}`).toBe(403);
      expect(await response.json()).toMatchObject({ error: 'forbidden' });
    }
  });

  it('lets an admin through to every admin route', async () => {
    const cookie = await sessionCookie(app);
    for (const route of adminRoutes(app)) {
      const response = await call(app, route, cookie);
      expect([401, 403], `${route.method} ${route.path}`).not.toContain(response.status);
    }
  });

  it('reads the role on every request, so a demotion takes effect at once', async () => {
    const cookie = await sessionCookie(app);
    expect((await app.request('/admin/runs', { headers: { cookie } })).status).toBe(200);
    vi.mocked(queries.getUser).mockResolvedValue({ ...ADMIN, role: 'user' } as never);
    expect((await app.request('/admin/runs', { headers: { cookie } })).status).toBe(403);
  });

  it('refuses a session whose user no longer exists', async () => {
    const cookie = await sessionCookie(app);
    vi.mocked(queries.getUser).mockResolvedValue(null);
    expect((await app.request('/admin/runs', { headers: { cookie } })).status).toBe(403);
  });

  it('gates paths under the prefix that have no route, so a probe learns nothing', async () => {
    expect((await app.request('/admin/no-such-thing')).status).toBe(401);
    expect((await app.request('/admin')).status).toBe(401);
  });

  it('does not treat a path that merely starts with the word as admin', () => {
    expect(isAdminPath('/administrator')).toBe(false);
    expect(isAdminPath('/admin')).toBe(true);
    expect(isAdminPath('/admin/runs')).toBe(true);
  });

  it('lists the runs of every account and of none', async () => {
    vi.mocked(queries.listAllRuns).mockResolvedValueOnce([
      {
        id: 'run-1',
        user_id: null,
        kind: 'backfill',
        run_key: 'backfill:k8s:2026-09-30',
        trigger: 'cron',
        status: 'ok',
        started_at: new Date('2026-09-30T06:45:00Z'),
        finished_at: new Date('2026-09-30T06:46:00Z'),
      },
    ]);
    const cookie = await sessionCookie(app);
    const response = await app.request('/admin/runs?kind=backfill', { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(queries.listAllRuns).toHaveBeenCalledWith('backfill', expect.any(Number));
    expect(await response.json()).toEqual({
      runs: [
        {
          id: 'run-1',
          userId: null,
          kind: 'backfill',
          runKey: 'backfill:k8s:2026-09-30',
          trigger: 'cron',
          status: 'ok',
          startedAt: '2026-09-30T06:45:00.000Z',
          finishedAt: '2026-09-30T06:46:00.000Z',
        },
      ],
    });
  });

  it('refuses a kind that is not a run kind', async () => {
    const cookie = await sessionCookie(app);
    const response = await app.request('/admin/runs?kind=DROP%20TABLE', { headers: { cookie } });
    expect(response.status).toBe(400);
  });
});
