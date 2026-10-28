/**
 * The privacy policy and terms on the server (D265): sign-up stores the version
 * its box agreed to, a user who has not accepted the current version can do
 * nothing but accept it, export or delete, and a production installation holds
 * *automatic* sign-up while the text is pending (D344). The database is mocked; mail is
 * recorded.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LEGAL_ACCEPTANCE_REQUIRED, LEGAL_VERSION } from '@traders/shared';

import { ACTIVE_SESSION, TEST_USER_ID, sessionCookie } from './session.js';

/** A published version, as the app would carry once the text exists. */
const VERSION = '2026-11-01';
const PASSWORD = 'a long enough passphrase';

const user = {
  ...ACTIVE_SESSION,
  id: TEST_USER_ID,
  email: 'noa@example.com',
  base_currency: 'USD',
  timezone: 'Europe/London',
  role: 'user' as 'user' | 'admin',
  /** What the session read says; the gate refuses on `false` alone. */
  legal_accepted: false,
};

vi.mock('../src/db/pool.js', () => ({
  queryOne: vi.fn(async () => ({ ok: 1 })),
  query: vi.fn(async () => []),
  transaction: vi.fn(),
  initPool: vi.fn(),
  getPool: vi.fn(),
  closePool: vi.fn(),
}));

vi.mock('../src/db/queries.js', () => ({
  // As the real read: nothing to accept while no version exists.
  getSessionUser: vi.fn(async (userId: string, _hash: unknown, _touch: unknown, legalVersion: string | null) => {
    const row = await (await import('./session.js')).mockedSessionUser(userId);
    return row && { ...row, legal_accepted: legalVersion === null || row.legal_accepted };
  }),
  getUser: vi.fn(async () => ({ ...user })),
  getOrCreateUserSettings: vi.fn(async () => ({ language: 'en' })),
  hasAcceptedLegalVersion: vi.fn(async () => user.legal_accepted),
  recordLegalAcceptance: vi.fn(async () => undefined),
  createSignupRequest: vi.fn(async () => ({ outcome: 'created', userId: '11111111-1111-4111-8111-111111111111' })),
  issueAuthToken: vi.fn(async () => undefined),
  getInstallationSettings: vi.fn(async () => ({
    max_agents_per_user: 3,
    assistant_daily_budget_micro_usd: 500_000,
    default_llm_cap_micro_usd: 10_000_000,
    max_pending_signups: 5,
    signup_mode: 'closed',
    daily_new_accounts_limit: 20,
    updated_at: new Date('2026-10-26T09:00:00Z'),
  })),
  setSignupMode: vi.fn(async () => undefined),
  insertAdminAudit: vi.fn(async () => undefined),
  getPasswordHash: vi.fn(async () => 'hash'),
  sessionSignedInWithin: vi.fn(async () => false),
  exportAccount: vi.fn(async () => '{"format":"traders-export-1"}'),
  getPortfolio: vi.fn(async () => []),
  listSessions: vi.fn(async () => []),
  peekVerificationToken: vi.fn(async () => ({ purpose: 'verify_email', open: true, accountEmail: 'noa@example.com', passwordHash: null })),
  useVerificationToken: vi.fn(async () => ({ outcome: 'activated', userId: TEST_USER_ID })),
}));

const { createApp } = await import('../src/http/app.js');
const { loadConfig, resetConfigForTests } = await import('../src/config.js');
const { createFakeAi } = await import('./fakeAi.js');
const { memoryRateLimits } = await import('../src/http/rateLimits.js');
const { RecordingEmailSender } = await import('./recordingEmailSender.js');
const { LEGAL_NOT_ACCEPTED } = await import('../src/http/routes/auth.js');
const queries = await import('../src/db/queries.js');

const ENV = {
  APP_ENV: 'test',
  LOG_LEVEL: 'error',
  SESSION_SECRET: 'test-session-secret-value',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  AI_SERVICE_URL: 'http://ai-service:8000',
  INTERNAL_API_KEY: 'internal-test-key',
  ALLOWED_ORIGINS: 'http://localhost:5173',
  // Mail configured, so *automatic* is refused for the legal text alone.
  SMTP_HOST: 'smtp.example.com',
  EMAIL_FROM: 'Traders <noreply@example.com>',
} as unknown as NodeJS.ProcessEnv;

const HEADERS = { origin: 'http://localhost:5173', 'content-type': 'application/json' };

function buildApp({ legalVersion = VERSION as string | null, production = false } = {}) {
  resetConfigForTests();
  const config = loadConfig({ ...ENV, APP_ENV: production ? 'production' : 'test', ...(production ? { ALLOWED_ORIGINS: 'https://traders.example,http://localhost:5173' } : {}) } as NodeJS.ProcessEnv);
  return createApp(config, createFakeAi(), undefined, null, memoryRateLimits(), new RecordingEmailSender(), new Map(), legalVersion);
}

type App = ReturnType<typeof buildApp>;

const SIGNUP = { email: 'noa@example.com', password: PASSWORD, timezone: 'Europe/London', language: 'en' };

function signup(app: App, body: Record<string, unknown>) {
  return app.request('/auth/signup', { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });
}

function signedIn(app: App, path: string, init: RequestInit = {}) {
  return app.request(path, { ...init, headers: { ...HEADERS, cookie: sessionCookie(), ...(init.headers ?? {}) } });
}

beforeEach(() => {
  vi.clearAllMocks();
  user.role = 'user';
  user.legal_accepted = false;
});

describe('the text this build ships (D265)', () => {
  it('is pending: the four files are placeholders until the user publishes them', () => {
    // When this fails, the text was published: the gate below opens on its own.
    expect(LEGAL_VERSION).toBeNull();
  });
});

describe('signing up agrees to the current version', () => {
  it('stores the version the box agreed to', async () => {
    const response = await signup(buildApp(), { ...SIGNUP, acceptedLegalVersion: VERSION });
    expect(await response.json()).toEqual({ outcome: 'received' });
    expect(queries.createSignupRequest).toHaveBeenCalledWith(expect.objectContaining({ legalVersion: VERSION }));
  });

  it('refuses a request whose box was not ticked, or agreed to another version', async () => {
    const app = buildApp();
    for (const accepted of [undefined, '2026-01-01']) {
      const response = await signup(app, { ...SIGNUP, ...(accepted ? { acceptedLegalVersion: accepted } : {}) });
      expect(response.status, String(accepted)).toBe(400);
      expect((await response.json()).error).toBe(LEGAL_NOT_ACCEPTED);
    }
    expect(queries.createSignupRequest).not.toHaveBeenCalled();
  });

  it('asks for nothing while the text is pending, outside production', async () => {
    const response = await signup(buildApp({ legalVersion: null }), SIGNUP);
    expect(await response.json()).toEqual({ outcome: 'received' });
    expect(queries.createSignupRequest).toHaveBeenCalledWith(expect.objectContaining({ legalVersion: null }));
  });
});

describe('a production installation with no text holds *automatic* only (D265, D344)', () => {
  const held = () => buildApp({ legalVersion: null, production: true });

  it('takes a request under *approval*, with no box to agree to, and tells the database to hold *automatic*', async () => {
    const response = await signup(held(), SIGNUP);
    expect(await response.json()).toEqual({ outcome: 'received' });
    expect(queries.createSignupRequest).toHaveBeenCalledWith(expect.objectContaining({ legalVersion: null, automaticHeld: true }));
  });

  it('answers closed when the stored mode is *automatic*: the database admits nobody', async () => {
    vi.mocked(queries.createSignupRequest).mockResolvedValueOnce({ outcome: 'closed' });
    const response = await signup(held(), SIGNUP);
    expect(await response.json()).toEqual({ outcome: 'closed' });
  });

  it("opens a sign-up's link under the same hold, and passes on what the database decided", async () => {
    const verify = () =>
      held().request('/auth/verify', {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({ token: 'the-token', password: PASSWORD }),
      });
    vi.mocked(queries.peekVerificationToken).mockResolvedValue({
      purpose: 'verify_email',
      open: true,
      accountEmail: 'noa@example.com',
      passwordHash: await (await import('../src/http/password.js')).hashPassword(PASSWORD),
    });
    // A stored *automatic*: the link stays unused (the database does not mark it).
    vi.mocked(queries.useVerificationToken).mockResolvedValueOnce({ outcome: 'signup_full' });
    expect(await (await verify()).json()).toEqual({ outcome: 'signup_full' });
    vi.mocked(queries.useVerificationToken).mockResolvedValueOnce({ outcome: 'awaiting_approval', userId: TEST_USER_ID });
    expect(await (await verify()).json()).toEqual({ outcome: 'awaiting_approval' });
    for (const call of vi.mocked(queries.useVerificationToken).mock.calls) {
      expect(call[1]).toMatchObject({ automaticHeld: true });
    }
  });

  it('refuses *automatic* on the Admin page, allows *approval* and *closed*, and says why', async () => {
    user.role = 'admin';
    const app = held();
    const automatic = await signedIn(app, '/admin/settings', { method: 'PUT', body: JSON.stringify({ signupMode: 'automatic' }) });
    expect(automatic.status).toBe(422);
    expect((await automatic.json()).error).toBe('legal_text_pending');
    expect(queries.setSignupMode).not.toHaveBeenCalled();
    for (const signupMode of ['approval', 'closed']) {
      const response = await signedIn(app, '/admin/settings', { method: 'PUT', body: JSON.stringify({ signupMode }) });
      expect(response.status, signupMode).toBe(200);
      expect((await response.json()).automaticSignupHeldForLegalText).toBe(true);
      expect(queries.setSignupMode).toHaveBeenLastCalledWith(signupMode, TEST_USER_ID);
    }
  });

  it('holds nothing once the text exists, nor on a development installation', async () => {
    user.role = 'admin';
    for (const app of [buildApp({ production: true }), buildApp({ legalVersion: null })]) {
      const response = await signedIn(app, '/admin/settings', { method: 'PUT', body: JSON.stringify({ signupMode: 'automatic' }) });
      expect(response.status).toBe(200);
      expect((await response.json()).automaticSignupHeldForLegalText).toBe(false);
    }
    await signup(buildApp({ legalVersion: null }), SIGNUP);
    expect(queries.createSignupRequest).toHaveBeenCalledWith(expect.objectContaining({ automaticHeld: false }));
  });
});

describe('a user who has not accepted the current version', () => {
  it('is refused everything behind the session gate', async () => {
    const response = await signedIn(buildApp(), '/settings');
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe(LEGAL_ACCEPTANCE_REQUIRED);
  });

  it('can still export their data and reach the deletion', async () => {
    const app = buildApp();
    const exported = await signedIn(app, '/account/export');
    expect(exported.status).toBe(200);
    const deletion = await signedIn(app, '/account/deletion');
    expect(deletion.status).toBe(200);
  });

  it('can still see and end its signed-in devices', async () => {
    const response = await signedIn(buildApp(), '/account/sessions');
    expect(response.status).toBe(200);
  });

  it('is refused at a near miss of an open path, never let through', async () => {
    const app = buildApp();
    for (const path of ['/account/export/', '/Account/export', '/account/sessionsX']) {
      expect((await signedIn(app, path)).status, path).not.toBe(200);
    }
  });

  it('is told which version, in the session', async () => {
    const response = await signedIn(buildApp(), '/auth/session');
    expect((await response.json()).user.legalAcceptanceRequired).toBe(VERSION);
  });

  it('accepts the version the page showed, and the app opens', async () => {
    const app = buildApp();
    vi.mocked(queries.recordLegalAcceptance).mockImplementationOnce(async () => {
      user.legal_accepted = true;
    });
    const response = await signedIn(app, '/auth/legal/accept', { method: 'POST', body: JSON.stringify({ version: VERSION }) });
    expect(response.status).toBe(200);
    expect((await response.json()).legalAcceptanceRequired).toBeNull();
    expect(queries.recordLegalAcceptance).toHaveBeenCalledWith(TEST_USER_ID, VERSION);
    expect((await signedIn(app, '/settings')).status).not.toBe(403);
  });

  it('cannot accept a version that is not the current one, nor any while the text is pending', async () => {
    for (const [app, version] of [
      [buildApp(), '2026-01-01'],
      [buildApp({ legalVersion: null }), VERSION],
    ] as const) {
      const response = await signedIn(app, '/auth/legal/accept', { method: 'POST', body: JSON.stringify({ version }) });
      expect(response.status).toBe(409);
      expect((await response.json()).error).toBe('legal_version_stale');
    }
    expect(queries.recordLegalAcceptance).not.toHaveBeenCalled();
  });

  it('cannot accept signed out', async () => {
    const response = await buildApp().request('/auth/legal/accept', {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ version: VERSION }),
    });
    expect(response.status).toBe(401);
  });
});

describe('who is never asked', () => {
  it('the admin, whose installation the terms are', async () => {
    user.role = 'admin';
    const app = buildApp();
    expect((await signedIn(app, '/settings')).status).not.toBe(403);
    expect((await (await signedIn(app, '/auth/session')).json()).user.legalAcceptanceRequired).toBeNull();
  });

  it('anyone, while the text is pending', async () => {
    const response = await signedIn(buildApp({ legalVersion: null }), '/auth/session');
    expect((await response.json()).user.legalAcceptanceRequired).toBeNull();
    expect(queries.hasAcceptedLegalVersion).not.toHaveBeenCalled();
  });
});
