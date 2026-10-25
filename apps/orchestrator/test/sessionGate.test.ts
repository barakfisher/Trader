/**
 * Every route the app registers is behind the session gate, or on the short
 * public list below with the reason it may be reached without one.
 *
 * Behind the gate means two answers: 401 with no session, and 403
 * `password_change_required` for a session whose one-time password is not yet
 * changed (D162). A route that checks the user itself (`currentUserId`) gets the
 * first answer and not the second, which is how `/narration` and `/universe`
 * slipped past it; so both are asserted, for every route.
 *
 * The routes are read from the app, as `adminGuard.test.ts` reads the admin
 * ones: a list of gated routes here would be one more thing to forget. The
 * public list is the opposite case - joining it is the decision a reviewer
 * should see.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTIVE_SESSION, sessionCookie } from './session.js';

const USER = {
  ...ACTIVE_SESSION,
  id: '00000000-0000-0000-0000-000000000001',
  email: 'dana@example.com',
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
  getSessionUser: vi.fn(async (userId: string) => (await import('./session.js')).mockedSessionUser(userId)),
  getUser: vi.fn(async () => USER),
}));

const { loadConfig, resetConfigForTests } = await import('../src/config.js');
const { createApp } = await import('../src/http/app.js');
const { createFakeAi } = await import('./fakeAi.js');
const queries = await import('../src/db/queries.js');

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

/** Reached without a session, each for its reason. Prefixes match as the gate's do. */
const PUBLIC_PREFIXES = [
  // Probes: Kubernetes and compose call them with no cookie.
  '/healthz',
  '/readyz',
  // Signing in, signing up and changing the one-time password must work before
  // there is a usable session; the routes that need one check it themselves.
  '/auth',
  // Called by the scheduler and CronJobs with `INTERNAL_API_KEY`, not a cookie.
  '/internal',
  // Called by Telegram; proves itself with the webhook's secret header.
  '/telegram/webhook',
];

function isPublic(path: string): boolean {
  return PUBLIC_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function buildApp() {
  resetConfigForTests();
  return createApp(loadConfig(ENV), createFakeAi());
}

type App = ReturnType<typeof buildApp>;
type Route = { method: string; path: string };

/** Every concrete route: method and path, parameters filled in. */
function allRoutes(app: App): Route[] {
  const seen = new Set<string>();
  const routes: Route[] = [];
  for (const route of app.routes) {
    // Middleware registers as ALL on '*'; only handlers name a real path.
    if (route.method === 'ALL' || route.path.includes('*')) continue;
    const path = route.path.replace(/:[A-Za-z]+/g, 'x');
    const key = `${route.method} ${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push({ method: route.method, path });
  }
  return routes;
}

function gatedRoutes(app: App): Route[] {
  return allRoutes(app).filter((route) => !isPublic(route.path));
}

function call(app: App, route: Route, cookie?: string) {
  const headers: Record<string, string> = { origin: ORIGIN, 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  const hasBody = route.method !== 'GET' && route.method !== 'HEAD';
  return app.request(route.path, {
    method: route.method,
    headers,
    body: hasBody ? '{}' : undefined,
  });
}

describe('the session gate', () => {
  let app: App;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queries.getUser).mockResolvedValue(USER as never);
    app = buildApp();
  });

  it('finds routes on both sides of it', () => {
    expect(gatedRoutes(app).length).toBeGreaterThan(0);
    expect(allRoutes(app).filter((route) => isPublic(route.path)).length).toBeGreaterThan(0);
  });

  it('answers 401 on every route outside the public list without a session', async () => {
    for (const route of gatedRoutes(app)) {
      const response = await call(app, route);
      expect(response.status, `${route.method} ${route.path}`).toBe(401);
    }
  });

  it('holds every route outside the public list until the one-time password is changed (D162)', async () => {
    vi.mocked(queries.getUser).mockResolvedValue({ ...USER, password_must_change: true } as never);
    const cookie = sessionCookie();
    for (const route of gatedRoutes(app)) {
      const response = await call(app, route, cookie);
      expect(response.status, `${route.method} ${route.path}`).toBe(403);
      expect(await response.json(), `${route.method} ${route.path}`).toMatchObject({
        error: 'password_change_required',
      });
    }
  });

  it('gates the two routes that once checked the user themselves', async () => {
    const paths = gatedRoutes(app).map((route) => route.path);
    expect(paths).toContain('/narration');
    expect(paths).toContain('/universe/taxonomy');
  });
});
