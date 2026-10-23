/**
 * The admin's user list and its actions (D162, D239): operations only, the
 * admin's own row never touched, each action audited before it runs, and a
 * one-time password answered once and never written to the audit.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { passwordProblem } from '@traders/shared';
import { ACTIVE_SESSION, sessionCookie } from './session.js';

const ADMIN = {
  ...ACTIVE_SESSION,
  id: '00000000-0000-0000-0000-000000000001',
  email: 'admin@example.com',
  base_currency: 'USD',
  timezone: 'Asia/Jerusalem',
  role: 'admin',
};
const DANA = '00000000-0000-0000-0000-0000000000d1';

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
  insertAdminAudit: vi.fn(async () => undefined),
  listUsersForAdmin: vi.fn(async () => [
    {
      id: ADMIN.id,
      email: 'admin@example.com',
      role: 'admin',
      status: 'active',
      timezone: 'Asia/Jerusalem',
      spent_this_month_micro_usd: '0',
      own_key_status: null,
      last_sign_in_at: new Date('2026-10-21T05:00:00Z'),
      approved_at: null,
    },
    {
      id: DANA,
      email: 'dana@example.com',
      role: 'user',
      status: 'disabled',
      timezone: 'Europe/London',
      spent_this_month_micro_usd: '1250',
      own_key_status: 'valid',
      last_sign_in_at: null,
      approved_at: new Date('2026-10-20T12:00:00Z'),
    },
  ]),
  setUserStatus: vi.fn(async (id: string) => ({ id })),
  setOneTimePassword: vi.fn(async (id: string) => ({ id })),
}));

const { loadConfig, resetConfigForTests } = await import('../src/config.js');
const { createApp } = await import('../src/http/app.js');
const { createFakeAi } = await import('./fakeAi.js');
const { passwordMatches } = await import('../src/http/password.js');
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

const HEADERS = { origin: 'http://localhost:5173', 'content-type': 'application/json' };

function buildApp() {
  resetConfigForTests();
  return createApp(loadConfig(ENV), createFakeAi());
}

describe("the admin's user list (D162, D239)", () => {
  let app: ReturnType<typeof buildApp>;
  const request = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { ...HEADERS, cookie: sessionCookie() },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queries.getUser).mockResolvedValue(ADMIN as never);
    app = buildApp();
  });

  it('lists accounts with operations only - no holdings, agents or conversations', async () => {
    const response = await request('GET', '/admin/users');
    expect(response.status).toBe(200);
    const { users } = (await response.json()) as { users: Record<string, unknown>[] };
    expect(users[1]).toEqual({
      userId: DANA,
      email: 'dana@example.com',
      role: 'user',
      status: 'disabled',
      timezone: 'Europe/London',
      spentThisMonthMicroUsd: 1250,
      ownKey: 'valid',
      lastSignInAt: null,
      approvedAt: '2026-10-20T12:00:00.000Z',
    });
    expect(users[0]).toMatchObject({ role: 'admin', ownKey: 'none' });
    expect(users[0]).not.toHaveProperty('llmCapMicroUsd');
  });

  it('is the admin\'s only', async () => {
    vi.mocked(queries.getUser).mockResolvedValue({ ...ADMIN, role: 'user' } as never);
    expect((await request('GET', '/admin/users')).status).toBe(403);
    expect((await request('POST', `/admin/users/${DANA}/disable`)).status).toBe(403);
    expect(queries.setUserStatus).not.toHaveBeenCalled();
  });

  it('disables an active user and enables a disabled one, audited first', async () => {
    expect((await request('POST', `/admin/users/${DANA}/disable`)).status).toBe(200);
    expect(queries.setUserStatus).toHaveBeenLastCalledWith(DANA, 'active', 'disabled');
    expect(vi.mocked(queries.insertAdminAudit).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(queries.setUserStatus).mock.invocationCallOrder[0]!,
    );
    expect((await request('POST', `/admin/users/${DANA}/enable`)).status).toBe(200);
    expect(queries.setUserStatus).toHaveBeenLastCalledWith(DANA, 'disabled', 'active');
  });

  it('answers 409 when the query changed nothing - the admin, or the wrong state', async () => {
    vi.mocked(queries.setUserStatus).mockResolvedValueOnce(null);
    const response = await request('POST', `/admin/users/${ADMIN.id}/disable`);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'not_disableable' });
  });

  it('has no cap to set: the route is gone with the cap (D274)', async () => {
    expect((await request('PUT', `/admin/users/${DANA}/cap`, { llmCapMicroUsd: 20_000_000 })).status).toBe(404);
  });

  it('makes a one-time password that passes the length rule, stores only its hash, and never audits it', async () => {
    const response = await request('POST', `/admin/users/${DANA}/one-time-password`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const { password, userId } = (await response.json()) as { password: string; userId: string };
    expect(userId).toBe(DANA);
    expect(passwordProblem(password)).toBeNull();
    const [, stored] = vi.mocked(queries.setOneTimePassword).mock.calls[0]!;
    expect(stored).not.toContain(password);
    expect(await passwordMatches(password, stored)).toBe(true);
    expect(JSON.stringify(vi.mocked(queries.insertAdminAudit).mock.calls)).not.toContain(password);

    const again = (await (await request('POST', `/admin/users/${DANA}/one-time-password`)).json()) as { password: string };
    expect(again.password).not.toBe(password);
  });
});
