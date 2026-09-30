/**
 * Every admin request that can change something is recorded in `admin_audit`
 * before it runs, and does not run if it cannot be recorded (decision 84).
 *
 * No admin route changes anything yet - the rescreen (M8) is the first - so the
 * action here is a route this test registers under `/admin`, exactly as a real
 * one would be. That the gate reaches it without the route asking is the point.
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
  listAllRuns: vi.fn(async () => []),
  listAdminAudit: vi.fn(async () => []),
  insertAdminAudit: vi.fn(async () => undefined),
  listOpsEvents: vi.fn(async () => []),
  getLatestUniverseLoad: vi.fn(async () => null),
  countUniverse: vi.fn(async () => ({ profiles: 0, equities: 0, etfs: 0, embedded: 0, etf_holdings: 0 })),
}));

const { loadConfig, resetConfigForTests } = await import('../src/config.js');
const { createApp } = await import('../src/http/app.js');
const { clientAddress, MAX_AUDITED_BODY_BYTES } = await import('../src/http/adminAudit.js');
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

const HEADERS = { origin: 'http://localhost:5173', 'content-type': 'application/json' };

/** What happened, in order: the audit write and the action. */
let events: string[] = [];
let actionBody: unknown;

function buildApp() {
  resetConfigForTests();
  const app = createApp(loadConfig(ENV), createFakeAi());
  app.post('/admin/example-action', async (context) => {
    actionBody = await context.req.json();
    events.push('action');
    return context.json({ done: true });
  });
  return app;
}

type App = ReturnType<typeof buildApp>;

async function sessionCookie(app: App): Promise<string> {
  const response = await app.request('/auth/login', {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ passphrase: 'test-passphrase' }),
  });
  return (response.headers.get('set-cookie') as string).split(';')[0]!;
}

describe('the admin audit', () => {
  let app: App;
  let cookie: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    events = [];
    actionBody = undefined;
    vi.mocked(queries.getUser).mockResolvedValue(ADMIN as never);
    vi.mocked(queries.insertAdminAudit).mockImplementation(async () => {
      events.push('audit');
    });
    app = buildApp();
    cookie = await sessionCookie(app);
  });

  it('records an admin action before it runs, with who, what and the request', async () => {
    const response = await app.request('/admin/example-action?dry=1', {
      method: 'POST',
      headers: {
        ...HEADERS,
        cookie,
        'x-request-id': 'req-1',
        'x-forwarded-for': '6.6.6.6, 10.0.0.7',
      },
      body: JSON.stringify({ scope: 'universe' }),
    });
    expect(response.status).toBe(200);
    expect(events).toEqual(['audit', 'action']);
    expect(queries.insertAdminAudit).toHaveBeenCalledWith({
      adminUserId: ADMIN.id,
      action: 'POST /admin/example-action',
      detail: {
        query: { dry: '1' },
        body: { scope: 'universe' },
        forwardedFor: '6.6.6.6, 10.0.0.7',
      },
      ipAddress: '10.0.0.7',
      requestId: 'req-1',
    });
  });

  it('leaves the body readable for the action', async () => {
    await app.request('/admin/example-action', {
      method: 'POST',
      headers: { ...HEADERS, cookie },
      body: JSON.stringify({ scope: 'universe' }),
    });
    expect(actionBody).toEqual({ scope: 'universe' });
  });

  it('does not run an action whose audit row could not be written', async () => {
    vi.mocked(queries.insertAdminAudit).mockRejectedValueOnce(new Error('connection lost'));
    const response = await app.request('/admin/example-action', {
      method: 'POST',
      headers: { ...HEADERS, cookie },
      body: '{}',
    });
    expect(response.status).toBe(500);
    expect(events).toEqual([]);
  });

  it('does not record reads', async () => {
    const response = await app.request('/admin/runs', { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(queries.insertAdminAudit).not.toHaveBeenCalled();
  });

  it('records nothing for a refused non-admin: nothing was done by an admin', async () => {
    vi.mocked(queries.getUser).mockResolvedValue({ ...ADMIN, role: 'user' } as never);
    const response = await app.request('/admin/example-action', {
      method: 'POST',
      headers: { ...HEADERS, cookie },
      body: '{}',
    });
    expect(response.status).toBe(403);
    expect(queries.insertAdminAudit).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('records the size of a body too large to keep, and of one that is not JSON', async () => {
    const large = JSON.stringify({ blob: 'x'.repeat(MAX_AUDITED_BODY_BYTES) });
    await app.request('/admin/example-action', {
      method: 'POST',
      headers: { ...HEADERS, cookie },
      body: large,
    });
    expect(vi.mocked(queries.insertAdminAudit).mock.calls[0]![0].detail).toMatchObject({
      body: { omitted: 'too large', bytes: Buffer.byteLength(large) },
    });

    await app.request('/admin/example-action', {
      method: 'POST',
      headers: { ...HEADERS, cookie },
      body: 'not json',
    });
    expect(vi.mocked(queries.insertAdminAudit).mock.calls[1]![0].detail).toMatchObject({
      body: { omitted: 'not JSON', bytes: 8 },
    });
  });

  it('lists what was recorded, newest first', async () => {
    vi.mocked(queries.listAdminAudit).mockResolvedValueOnce([
      {
        id: '7',
        admin_user_id: ADMIN.id,
        action: 'POST /admin/universe/rescreen',
        detail: { body: null },
        ip_address: '10.0.0.7',
        request_id: 'req-1',
        occurred_at: new Date('2026-10-01T06:00:00Z'),
      },
    ]);
    const response = await app.request('/admin/audit', { headers: { cookie } });
    expect(await response.json()).toEqual({
      entries: [
        {
          id: '7',
          adminUserId: ADMIN.id,
          action: 'POST /admin/universe/rescreen',
          detail: { body: null },
          ipAddress: '10.0.0.7',
          requestId: 'req-1',
          occurredAt: '2026-10-01T06:00:00.000Z',
        },
      ],
    });
  });
});

describe('the universe gaps', () => {
  it('lists gaps counted, not repeated, and refuses an unknown kind', async () => {
    vi.mocked(queries.getUser).mockResolvedValue(ADMIN as never);
    vi.mocked(queries.listOpsEvents).mockResolvedValueOnce([
      {
        id: '3',
        kind: 'universe_gap_missing_ticker',
        user_id: ADMIN.id,
        detail: { symbol: 'SAP.DE', gap: 'outside_screen', rule: 'exchange' },
        occurrences: 4,
        occurred_at: new Date('2026-10-01T06:00:00Z'),
        last_seen_at: new Date('2026-10-01T09:00:00Z'),
      },
    ]);
    const app = buildApp();
    const cookie = await sessionCookie(app);
    const response = await app.request('/admin/gaps?kind=universe_gap_missing_ticker', {
      headers: { cookie },
    });
    expect(queries.listOpsEvents).toHaveBeenCalledWith('universe_gap_missing_ticker', expect.any(Number));
    expect(await response.json()).toEqual({
      gaps: [
        {
          id: '3',
          kind: 'universe_gap_missing_ticker',
          userId: ADMIN.id,
          detail: { symbol: 'SAP.DE', gap: 'outside_screen', rule: 'exchange' },
          occurrences: 4,
          firstSeenAt: '2026-10-01T06:00:00.000Z',
          lastSeenAt: '2026-10-01T09:00:00.000Z',
        },
      ],
    });
    const refused = await app.request('/admin/gaps?kind=narration', { headers: { cookie } });
    expect(refused.status).toBe(400);
  });
});

describe('the address an audit row records', () => {
  it('is the last forwarded hop - the one a proxy appended, not one a client wrote', () => {
    expect(clientAddress('6.6.6.6, 10.0.0.7', null)).toBe('10.0.0.7');
    expect(clientAddress('10.0.0.7', '172.18.0.4')).toBe('10.0.0.7');
  });

  it('is the socket peer when no proxy forwarded the request', () => {
    expect(clientAddress(undefined, '::1')).toBe('::1');
  });

  it('is null rather than anything the inet column would refuse', () => {
    expect(clientAddress('unknown', null)).toBeNull();
    expect(clientAddress(undefined, null)).toBeNull();
  });
});
