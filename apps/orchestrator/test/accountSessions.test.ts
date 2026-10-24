/**
 * The signed-in user's devices (D261, D294, D296): the list, signing one other
 * device out, signing out every other device, and the installation's sweep of
 * expired sessions. The database is mocked; which rows a statement touches is
 * `queries.postgres.test.ts`'s and the exit test's.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ACTIVE_SESSION, TEST_SESSION_ID, TEST_USER_ID, sessionCookie } from './session.js';

const USER = {
  ...ACTIVE_SESSION,
  id: TEST_USER_ID,
  email: 'dana@example.com',
  base_currency: 'USD',
  timezone: 'Asia/Jerusalem',
  role: 'user' as const,
};

const OTHER_SESSION_ID = '5e551000-0000-4000-8000-000000000002';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const EDGE_ON_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0';

vi.mock('../src/db/pool.js', () => ({
  queryOne: vi.fn(async () => ({ ok: 1 })),
  query: vi.fn(async () => []),
  transaction: vi.fn(),
  initPool: vi.fn(),
  getPool: vi.fn(),
  closePool: vi.fn(),
}));

vi.mock('../src/db/queries.js', () => ({
  getSessionUser: vi.fn(async (userId: string) => (await import('./session.js')).mockedSessionUser(userId)),
  getUser: vi.fn(),
  listSessions: vi.fn(),
  deleteSession: vi.fn(),
  deleteOtherSessions: vi.fn(),
  deleteExpiredSessions: vi.fn(),
  claimRun: vi.fn(async () => ({ claimed: true, runId: 'run-1' })),
  finishRun: vi.fn(async () => undefined),
  insertAdminAudit: vi.fn(),
}));

const { createApp } = await import('../src/http/app.js');
const { loadConfig, resetConfigForTests } = await import('../src/config.js');
const { describeSession } = await import('../src/http/sessions.js');
const { INSTALLATION_KINDS } = await import('../src/runKinds.js');
const queries = await import('../src/db/queries.js');
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

const ORIGIN = { origin: 'http://localhost:5173' };

function buildApp() {
  resetConfigForTests();
  return createApp(loadConfig(ENV), createFakeAi());
}

type App = ReturnType<typeof buildApp>;

function row(id: string, userAgent: string | null) {
  return {
    id,
    created_at: new Date('2026-10-20T08:00:00Z'),
    last_seen_at: new Date('2026-10-24T09:30:00Z'),
    expires_at: new Date('2026-10-27T08:00:00Z'),
    user_agent: userAgent,
    ip_address: '203.0.113.7',
  };
}

describe('the device list (D261, D294)', () => {
  let app: App;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queries.getUser).mockResolvedValue(USER);
    app = buildApp();
  });

  it("lists the user's sessions, marks this device, and names browser and OS from the user agent", async () => {
    vi.mocked(queries.listSessions).mockResolvedValue([row(TEST_SESSION_ID, EDGE_ON_WINDOWS), row(OTHER_SESSION_ID, IPHONE)]);
    const response = await app.request('/account/sessions', { headers: { cookie: sessionCookie() } });
    expect(response.status).toBe(200);
    expect(queries.listSessions).toHaveBeenCalledWith(USER.id);
    expect(await response.json()).toEqual({
      sessions: [
        {
          id: TEST_SESSION_ID,
          browser: 'Microsoft Edge',
          os: 'Windows',
          deviceType: 'desktop',
          signedInAt: '2026-10-20T08:00:00.000Z',
          lastSeenAt: '2026-10-24T09:30:00.000Z',
          expiresAt: '2026-10-27T08:00:00.000Z',
          ipAddress: '203.0.113.7',
          current: true,
        },
        expect.objectContaining({ id: OTHER_SESSION_ID, browser: 'Safari', os: 'iOS', deviceType: 'mobile', current: false }),
      ],
    });
  });

  it('never sends the user agent itself, or anything that could name the session to a cookie', async () => {
    vi.mocked(queries.listSessions).mockResolvedValue([row(TEST_SESSION_ID, IPHONE)]);
    const text = await (await app.request('/account/sessions', { headers: { cookie: sessionCookie() } })).text();
    expect(text).not.toContain('Mozilla');
    expect(text).not.toMatch(/token|hash|secret/i);
  });

  it('says nothing it cannot read from an empty or missing user agent', () => {
    for (const userAgent of [null, '']) {
      expect(describeSession(row(OTHER_SESSION_ID, userAgent), TEST_SESSION_ID)).toMatchObject({
        browser: null,
        os: null,
        deviceType: null,
        current: false,
      });
    }
  });

  it('shows an IPv4 address that arrived over IPv6 as IPv4, and any other as stored', () => {
    const shown = (address: string) => describeSession({ ...row(OTHER_SESSION_ID, null), ip_address: address }, undefined).ipAddress;
    expect(shown('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(shown('2001:db8::1')).toBe('2001:db8::1');
    expect(shown('203.0.113.7')).toBe('203.0.113.7');
  });

  it('needs a session', async () => {
    expect((await app.request('/account/sessions')).status).toBe(401);
    expect(queries.listSessions).not.toHaveBeenCalled();
  });

  it('waits for a one-time password to be changed first (D162)', async () => {
    vi.mocked(queries.getUser).mockResolvedValue({ ...USER, password_must_change: true });
    const response = await app.request('/account/sessions', { headers: { cookie: sessionCookie() } });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'password_change_required' });
  });
});

describe('signing another device out (D261)', () => {
  let app: App;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queries.getUser).mockResolvedValue(USER);
    app = buildApp();
  });

  const signOut = (id: string, cookie = sessionCookie()) =>
    app.request(`/account/sessions/${id}`, { method: 'DELETE', headers: { ...ORIGIN, cookie } });

  it("deletes that session, and only among the user's own", async () => {
    vi.mocked(queries.deleteSession).mockResolvedValue(true);
    const response = await signOut(OTHER_SESSION_ID);
    expect(response.status).toBe(204);
    expect(queries.deleteSession).toHaveBeenCalledWith(USER.id, OTHER_SESSION_ID);
  });

  it("answers 'not found' for a session that is not the user's - or does not exist", async () => {
    vi.mocked(queries.deleteSession).mockResolvedValue(false);
    const response = await signOut(OTHER_SESSION_ID);
    expect(response.status).toBe(404);
  });

  it("answers 'not found' for an id that is not one, without asking the database", async () => {
    expect((await signOut('not-a-uuid')).status).toBe(404);
    expect(queries.deleteSession).not.toHaveBeenCalled();
  });

  it('refuses this device: the menu signs it out (D296)', async () => {
    const response = await signOut(TEST_SESSION_ID);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'current_session' });
    expect(queries.deleteSession).not.toHaveBeenCalled();
  });

  it('refuses this device whatever the case of its id - Postgres would match it either way', async () => {
    const response = await signOut(TEST_SESSION_ID.toUpperCase());
    expect(response.status).toBe(400);
    expect(queries.deleteSession).not.toHaveBeenCalled();
  });

  it('needs a session and an Origin', async () => {
    expect((await app.request(`/account/sessions/${OTHER_SESSION_ID}`, { method: 'DELETE', headers: ORIGIN })).status).toBe(401);
    const noOrigin = await app.request(`/account/sessions/${OTHER_SESSION_ID}`, {
      method: 'DELETE',
      headers: { cookie: sessionCookie() },
    });
    expect(noOrigin.status).toBe(403);
    expect(queries.deleteSession).not.toHaveBeenCalled();
  });
});

describe('signing out every other device (D296)', () => {
  let app: App;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queries.getUser).mockResolvedValue(USER);
    app = buildApp();
  });

  it('keeps this session and ends the rest', async () => {
    vi.mocked(queries.deleteOtherSessions).mockResolvedValue(2);
    const response = await app.request('/account/sessions/sign-out-others', {
      method: 'POST',
      headers: { ...ORIGIN, cookie: sessionCookie() },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ended: 2 });
    expect(queries.deleteOtherSessions).toHaveBeenCalledWith(USER.id, TEST_SESSION_ID);
  });

  it('needs a session', async () => {
    const response = await app.request('/account/sessions/sign-out-others', { method: 'POST', headers: ORIGIN });
    expect(response.status).toBe(401);
    expect(queries.deleteOtherSessions).not.toHaveBeenCalled();
  });
});

describe('the session sweep (D261)', () => {
  beforeEach(() => vi.clearAllMocks());

  it("is the installation's run, for nobody", () => {
    expect(INSTALLATION_KINDS.has('session_sweep')).toBe(true);
  });

  it('deletes expired sessions and records how many', async () => {
    vi.mocked(queries.deleteExpiredSessions).mockResolvedValue(3);
    const response = await buildApp().request('/internal/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': 'internal-test-key' },
      body: JSON.stringify({ kind: 'session_sweep', trigger: 'test' }),
    });
    expect(response.status).toBe(200);
    expect(queries.claimRun).toHaveBeenCalledWith(expect.objectContaining({ kind: 'session_sweep', userId: null }));
    expect(queries.finishRun).toHaveBeenCalledWith('run-1', 'ok', { deleted: 3 });
  });
});
