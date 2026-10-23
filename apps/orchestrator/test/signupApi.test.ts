/**
 * Asking to join and the admin's decision on the Admin page (D156, D185-D188).
 * The database and the Telegram announcement are mocked; the hashing is real.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ACTIVE_SESSION, TEST_USER_ID, sessionCookie } from './session.js';

const ADMIN = {
  ...ACTIVE_SESSION,
  id: TEST_USER_ID,
  email: 'admin@example.com',
  base_currency: 'USD',
  timezone: 'Asia/Jerusalem',
  role: 'admin' as const,
};
const REQUESTER = '11111111-1111-4111-8111-111111111111';
const PASSWORD = 'a long enough passphrase';

vi.mock('../src/db/pool.js', () => ({
  queryOne: vi.fn(async () => ({ ok: 1 })),
  query: vi.fn(async () => []),
  transaction: vi.fn(),
  initPool: vi.fn(),
  getPool: vi.fn(),
  closePool: vi.fn(),
}));

vi.mock('../src/db/queries.js', () => ({
  getUser: vi.fn(),
  createSignupRequest: vi.fn(),
  listSignupRequests: vi.fn(),
  countPendingSignups: vi.fn(async () => 2),
  approveSignup: vi.fn(),
  rejectSignup: vi.fn(),
  restoreSignup: vi.fn(),
  getInstallationSettings: vi.fn(async () => ({ default_llm_cap_micro_usd: 10_000_000 })),
  getOrCreateUserSettings: vi.fn(async () => ({ language: 'en' })),
  insertAdminAudit: vi.fn(async () => undefined),
}));

vi.mock('../src/telegram/signupApproval.js', () => ({ announceSignupRequest: vi.fn(async () => undefined) }));

const { createApp } = await import('../src/http/app.js');
const { loadConfig, resetConfigForTests } = await import('../src/config.js');
const { passwordMatches } = await import('../src/http/password.js');
const { announceSignupRequest } = await import('../src/telegram/signupApproval.js');
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

const HEADERS = { origin: 'http://localhost:5173', 'content-type': 'application/json' };

function buildApp() {
  resetConfigForTests();
  return createApp(loadConfig(ENV), createFakeAi());
}

type App = ReturnType<typeof buildApp>;

const REQUEST = { email: ' Noa@Example.com ', password: PASSWORD, timezone: 'Europe/London', language: 'he' };

function signup(app: App, body: unknown = REQUEST) {
  return app.request('/auth/signup', { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });
}

describe('asking to join (D156, D185)', () => {
  let app: App;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp();
  });

  it('writes a pending request with a real hash, and announces only a new one', async () => {
    vi.mocked(queries.createSignupRequest).mockResolvedValue({ outcome: 'created', userId: REQUESTER });
    const response = await signup(app);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: 'received' });

    const input = vi.mocked(queries.createSignupRequest).mock.calls[0]![0];
    expect(input).toMatchObject({ email: 'noa@example.com', timezone: 'Europe/London', language: 'he' });
    expect(await passwordMatches(PASSWORD, input.passwordHash)).toBe(true);
    expect(announceSignupRequest).toHaveBeenCalledWith(expect.anything(), REQUESTER);
  });

  it('answers an email that already asked, or has an account, exactly as a new one - and tells nobody', async () => {
    vi.mocked(queries.createSignupRequest).mockResolvedValue({ outcome: 'exists' });
    const response = await signup(app);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: 'received' });
    expect(announceSignupRequest).not.toHaveBeenCalled();
  });

  it('says sign-up is closed while the limit on waiting requests is reached', async () => {
    vi.mocked(queries.createSignupRequest).mockResolvedValue({ outcome: 'closed' });
    const response = await signup(app);
    expect(await response.json()).toEqual({ outcome: 'closed' });
    expect(announceSignupRequest).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...REQUEST, email: 'not an address' }, 'email_invalid'],
    [{ ...REQUEST, password: 'short' }, 'password_too_short'],
    [{ ...REQUEST, timezone: '+02:00' }, 'timezone_invalid'],
    [{ ...REQUEST, language: 'fr' }, 'invalid_body'],
  ])('refuses %j as %s, writing nothing', async (body, code) => {
    const response = await signup(app, body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: code });
    expect(queries.createSignupRequest).not.toHaveBeenCalled();
  });
});

describe('deciding a request on the Admin page (D188)', () => {
  let app: App;
  let cookie: string;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queries.getUser).mockResolvedValue(ADMIN);
    app = buildApp();
    cookie = sessionCookie();
  });

  const post = (path: string, body?: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { ...HEADERS, cookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it('lists waiting requests and rejections, and nothing of the account', async () => {
    vi.mocked(queries.listSignupRequests).mockResolvedValue({
      pending: [
        { user_id: REQUESTER, email: 'noa@example.com', timezone: 'Europe/London', status: 'pending', created_at: new Date('2026-10-19T08:00:00Z') },
      ],
      rejected: [],
    });
    const response = await app.request('/admin/signups', { headers: { cookie } });
    expect(await response.json()).toEqual({
      pending: [
        { userId: REQUESTER, email: 'noa@example.com', timezone: 'Europe/London', status: 'pending', requestedAt: '2026-10-19T08:00:00.000Z' },
      ],
      rejected: [],
    });
  });

  it('counts waiting requests for the Admin link', async () => {
    const response = await app.request('/admin/signups/count', { headers: { cookie } });
    expect(await response.json()).toEqual({ pending: 2 });
  });

  it('approves with no amount, names the admin, and audits the request first', async () => {
    vi.mocked(queries.approveSignup).mockResolvedValue({ applied: true, status: 'active', email: 'noa@example.com' });
    const response = await post(`/admin/signups/${REQUESTER}/approve`, {});
    expect(await response.json()).toEqual({ applied: true, status: 'active' });
    // The retired cap (D279) is written with the installation's default, only for its CHECK.
    const { default_llm_cap_micro_usd: retired } = await queries.getInstallationSettings();
    expect(queries.approveSignup).toHaveBeenCalledWith(REQUESTER, retired, ADMIN.id);
    expect(queries.insertAdminAudit).toHaveBeenCalledTimes(1);
  });

  it('answers a request already decided from Telegram with where it is now', async () => {
    vi.mocked(queries.rejectSignup).mockResolvedValue({ applied: false, status: 'active', email: 'noa@example.com' });
    const response = await post(`/admin/signups/${REQUESTER}/reject`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ applied: false, status: 'active' });
  });

  it('undoes a rejection', async () => {
    vi.mocked(queries.restoreSignup).mockResolvedValue({ applied: true, status: 'pending', email: 'noa@example.com' });
    const response = await post(`/admin/signups/${REQUESTER}/restore`);
    expect(await response.json()).toEqual({ applied: true, status: 'pending' });
  });

  it('refuses an id that is not one', async () => {
    const response = await post('/admin/signups/not-a-uuid/reject');
    expect(response.status).toBe(400);
    expect(queries.rejectSignup).not.toHaveBeenCalled();
  });

  it('is an admin page: a member is refused', async () => {
    vi.mocked(queries.getUser).mockResolvedValue({ ...ADMIN, role: 'user' });
    const response = await post(`/admin/signups/${REQUESTER}/approve`, { llmCapMicroUsd: 0 });
    expect(response.status).toBe(403);
    expect(queries.approveSignup).not.toHaveBeenCalled();
  });
});
