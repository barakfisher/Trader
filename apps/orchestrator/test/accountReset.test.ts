/**
 * Reset account, by group (task 18): the route refuses anything short of a
 * typed confirmation and a list of known groups, audits before it erases, and
 * hands the database exactly the groups asked for, for the signed-in account
 * only. What the reset erases is the database's (`test_account_reset_sql.py`).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ACCOUNT_RESET_CONFIRMATION, ACCOUNT_RESET_GROUPS } from '@traders/shared';

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
  insertAdminAudit: vi.fn(async () => undefined),
  resetAccount: vi.fn(async () => ({
    reset_id: 'r-1',
    counts: { holdings: 2, fills: 0, topics: 8 },
  })),
}));

const { loadConfig, resetConfigForTests } = await import('../src/config.js');
const { createApp } = await import('../src/http/app.js');
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

function buildApp() {
  resetConfigForTests();
  return createApp(loadConfig(ENV), createFakeAi());
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

describe('the account reset', () => {
  let app: App;
  let cookie: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = buildApp();
    cookie = await sessionCookie(app);
  });

  const reset = (body: unknown) =>
    app.request('/admin/account/reset', {
      method: 'POST',
      headers: { ...HEADERS, cookie },
      body: JSON.stringify(body),
    });

  it('erases the groups asked for, in their canonical order, once each, for this account', async () => {
    const response = await reset({
      groups: ['followed_topics', 'main_portfolio', 'followed_topics'],
      confirm: ACCOUNT_RESET_CONFIRMATION,
    });
    expect(response.status).toBe(200);
    expect(queries.resetAccount).toHaveBeenCalledWith(ADMIN.id, ['main_portfolio', 'followed_topics']);
    expect(await response.json()).toEqual({
      resetId: 'r-1',
      groups: ['main_portfolio', 'followed_topics'],
      erased: { holdings: 2, fills: 0, topics: 8 },
    });
  });

  it('is audited before anything is erased', async () => {
    await reset({ groups: [...ACCOUNT_RESET_GROUPS], confirm: ACCOUNT_RESET_CONFIRMATION });
    const audited = vi.mocked(queries.insertAdminAudit).mock.invocationCallOrder[0]!;
    const erased = vi.mocked(queries.resetAccount).mock.invocationCallOrder[0]!;
    expect(audited).toBeLessThan(erased);
    expect(vi.mocked(queries.insertAdminAudit).mock.calls[0]![0]).toMatchObject({
      action: 'POST /admin/account/reset',
      detail: { body: { groups: [...ACCOUNT_RESET_GROUPS] } },
    });
  });

  it('refuses without the typed word, in any other spelling', async () => {
    for (const confirm of ['', 'reset', 'Reset', ' RESET', 'איפוס']) {
      const response = await reset({ groups: ['main_portfolio'], confirm });
      expect(response.status, JSON.stringify(confirm)).toBe(422);
      expect((await response.json()).error).toBe('reset_not_confirmed');
    }
    expect(queries.resetAccount).not.toHaveBeenCalled();
  });

  it('refuses no groups, an unknown group and a malformed body', async () => {
    for (const body of [
      { groups: [], confirm: ACCOUNT_RESET_CONFIRMATION },
      { groups: ['everything'], confirm: ACCOUNT_RESET_CONFIRMATION },
      { groups: ['main_portfolio'] },
      { groups: ['main_portfolio'], confirm: ACCOUNT_RESET_CONFIRMATION, userId: 'someone-else' },
      null,
    ]) {
      expect((await reset(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(queries.resetAccount).not.toHaveBeenCalled();
  });
});
