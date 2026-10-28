/**
 * The installation's settings on the Admin page: how many simulated agents a
 * user may have (D72, migration 0047) and what one user's questions to the
 * assistant may spend a day (migration 0052). Read and changed by an admin
 * only, every change audited by the gate, each refused outside its bounds.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ASSISTANT_DAILY_BUDGET_CEILING_MICRO_USD,
  DAILY_NEW_ACCOUNTS_CEILING,
  MAX_AGENTS_PER_USER_CEILING,
} from '@traders/shared';
import { ACTIVE_SESSION, sessionCookie } from './session.js';

const ADMIN = {
  ...ACTIVE_SESSION,
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

let stored = 3;
let budget = 500_000;
let mode = 'approval';

vi.mock('../src/db/queries.js', () => ({
  getSessionUser: vi.fn(async (userId: string) => (await import('./session.js')).mockedSessionUser(userId)),
  getUser: vi.fn(async () => ADMIN),
  insertAdminAudit: vi.fn(async () => undefined),
  getInstallationSettings: vi.fn(async () => ({
    max_agents_per_user: stored,
    assistant_daily_budget_micro_usd: budget,
    max_pending_signups: 5,
    signup_mode: mode,
    daily_new_accounts_limit: 20,
    updated_at: new Date('2026-10-08T09:00:00Z'),
  })),
  setSignupMode: vi.fn(async (next: string) => {
    mode = next;
  }),
  setDailyNewAccountsLimit: vi.fn(async () => undefined),
  setMaxAgentsPerUser: vi.fn(async (max: number) => {
    stored = max;
  }),
  setAssistantDailyBudget: vi.fn(async (micro: number) => {
    budget = micro;
  }),
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

const HEADERS = { origin: 'http://localhost:5173', 'content-type': 'application/json' };

describe('the installation settings (D72)', () => {
  let app: ReturnType<typeof createApp>;
  let cookie: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(queries.getUser).mockResolvedValue(ADMIN as never);
    stored = 3;
    budget = 500_000;
    mode = 'approval';
    resetConfigForTests();
    app = createApp(loadConfig(ENV), createFakeAi());
    cookie = sessionCookie();
  });

  const put = (body: unknown) =>
    app.request('/admin/settings', { method: 'PUT', headers: { ...HEADERS, cookie }, body: JSON.stringify(body) });

  it('reads the limit, three until an admin changes it', async () => {
    const response = await app.request('/admin/settings', { headers: { ...HEADERS, cookie } });
    expect(await response.json()).toEqual({
      maxAgentsPerUser: 3,
      assistantDailyBudgetMicroUsd: 500_000,
      maxPendingSignups: 5,
      signupMode: 'approval',
      dailyNewAccountsLimit: 20,
      emailConfigured: false,
      automaticSignupHeldForLegalText: false,
      updatedAt: '2026-10-08T09:00:00.000Z',
    });
  });

  it('changes the signup mode and the daily limit, within its ceiling (D243, D305)', async () => {
    resetConfigForTests();
    app = createApp(loadConfig({ ...ENV, SMTP_HOST: 'mailpit', EMAIL_FROM: 'Traders <no-reply@example.test>' }), createFakeAi());
    const response = await put({ signupMode: 'automatic', dailyNewAccountsLimit: 40 });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ signupMode: 'automatic', emailConfigured: true });
    expect(queries.setSignupMode).toHaveBeenCalledWith('automatic', ADMIN.id);
    expect(queries.setDailyNewAccountsLimit).toHaveBeenCalledWith(40, ADMIN.id);
    for (const value of [-1, DAILY_NEW_ACCOUNTS_CEILING + 1, 1.5]) {
      expect((await put({ dailyNewAccountsLimit: value })).status, String(value)).toBe(400);
    }
    expect((await put({ signupMode: 'invite_only' })).status).toBe(400);
  });

  it('refuses *automatic* where no mail can be sent: nobody could prove an address (D259)', async () => {
    const response = await put({ signupMode: 'automatic' });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: 'email_unavailable' });
    expect(queries.setSignupMode).not.toHaveBeenCalled();
    expect((await put({ signupMode: 'closed' })).status).toBe(200);
  });

  it('changes it, names the admin who did, and audits the request', async () => {
    const response = await put({ maxAgentsPerUser: 5 });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ maxAgentsPerUser: 5 });
    expect(queries.setMaxAgentsPerUser).toHaveBeenCalledWith(5, ADMIN.id);
    expect(queries.setAssistantDailyBudget).not.toHaveBeenCalled();
    expect(queries.insertAdminAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'PUT /admin/settings' }));
  });

  it("changes the assistant's daily limit alone, leaving the agent limit as it was", async () => {
    const response = await put({ assistantDailyBudgetMicroUsd: 1_000_000 });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ maxAgentsPerUser: 3, assistantDailyBudgetMicroUsd: 1_000_000 });
    expect(queries.setAssistantDailyBudget).toHaveBeenCalledWith(1_000_000, ADMIN.id);
    expect(queries.setMaxAgentsPerUser).not.toHaveBeenCalled();
  });

  it("accepts a limit of zero - the assistant switched off - and refuses past the ceiling", async () => {
    expect((await put({ assistantDailyBudgetMicroUsd: 0 })).status).toBe(200);
    for (const value of [-1, ASSISTANT_DAILY_BUDGET_CEILING_MICRO_USD + 1, 0.5, '100']) {
      expect((await put({ assistantDailyBudgetMicroUsd: value })).status, String(value)).toBe(400);
    }
  });

  it('refuses a request that names no setting, or one it does not know', async () => {
    expect((await put({})).status).toBe(400);
    expect((await put({ theme: 'dark' })).status).toBe(400);
  });

  it('refuses a limit of none, past the ceiling, or not a whole number', async () => {
    for (const value of [0, MAX_AGENTS_PER_USER_CEILING + 1, 2.5, '3']) {
      expect((await put({ maxAgentsPerUser: value })).status, String(value)).toBe(400);
    }
    expect(queries.setMaxAgentsPerUser).not.toHaveBeenCalled();
  });

  it('is an admin page: a member is refused', async () => {
    vi.mocked(queries.getUser).mockResolvedValue({ ...ADMIN, role: 'member' } as never);
    expect((await put({ maxAgentsPerUser: 5 })).status).toBe(403);
  });
});
