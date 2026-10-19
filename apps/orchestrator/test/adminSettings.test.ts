/**
 * The installation's settings on the Admin page: how many simulated agents a
 * user may have (D72, migration 0047) and what one user's questions to the
 * assistant may spend a day (migration 0052). Read and changed by an admin
 * only, every change audited by the gate, each refused outside its bounds.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ASSISTANT_DAILY_BUDGET_CEILING_MICRO_USD, MAX_AGENTS_PER_USER_CEILING } from '@traders/shared';
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

vi.mock('../src/db/queries.js', () => ({
  getUser: vi.fn(async () => ADMIN),
  insertAdminAudit: vi.fn(async () => undefined),
  getInstallationSettings: vi.fn(async () => ({
    max_agents_per_user: stored,
    assistant_daily_budget_micro_usd: budget,
    updated_at: new Date('2026-10-08T09:00:00Z'),
  })),
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
      updatedAt: '2026-10-08T09:00:00.000Z',
    });
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
