/**
 * The installation's settings on the Admin page (D71, migration 0046): how many
 * simulated agents a user may have. Read and changed by an admin only, every
 * change audited by the gate, and refused outside 1-MAX_AGENTS_PER_USER_CEILING.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_AGENTS_PER_USER_CEILING } from '@traders/shared';

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

let stored = 3;

vi.mock('../src/db/queries.js', () => ({
  getUser: vi.fn(async () => ADMIN),
  insertAdminAudit: vi.fn(async () => undefined),
  getInstallationSettings: vi.fn(async () => ({
    max_agents_per_user: stored,
    updated_at: new Date('2026-10-08T09:00:00Z'),
  })),
  setMaxAgentsPerUser: vi.fn(async (max: number) => {
    stored = max;
  }),
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

describe('the installation settings (D71)', () => {
  let app: ReturnType<typeof createApp>;
  let cookie: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(queries.getUser).mockResolvedValue(ADMIN as never);
    stored = 3;
    resetConfigForTests();
    app = createApp(loadConfig(ENV), createFakeAi());
    const login = await app.request('/auth/login', {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ passphrase: 'test-passphrase' }),
    });
    cookie = (login.headers.get('set-cookie') as string).split(';')[0]!;
  });

  const put = (body: unknown) =>
    app.request('/admin/settings', { method: 'PUT', headers: { ...HEADERS, cookie }, body: JSON.stringify(body) });

  it('reads the limit, three until an admin changes it', async () => {
    const response = await app.request('/admin/settings', { headers: { ...HEADERS, cookie } });
    expect(await response.json()).toEqual({ maxAgentsPerUser: 3, updatedAt: '2026-10-08T09:00:00.000Z' });
  });

  it('changes it, names the admin who did, and audits the request', async () => {
    const response = await put({ maxAgentsPerUser: 5 });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ maxAgentsPerUser: 5 });
    expect(queries.setMaxAgentsPerUser).toHaveBeenCalledWith(5, ADMIN.id);
    expect(queries.insertAdminAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'PUT /admin/settings' }));
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
