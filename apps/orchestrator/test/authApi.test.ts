/**
 * Signing in and out, the session's checks against its row and the user (D160,
 * D261) and changing one's own password (D159, D162, D181). The database is mocked; the hashing is the
 * real argon2id, because "the stored hash verifies" is the behaviour.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ACTIVE_SESSION, TEST_SESSION_ID, TEST_USER_ID, sessionCookie } from './session.js';

const PASSWORD = 'correct horse battery staple';

const USER = {
  ...ACTIVE_SESSION,
  id: TEST_USER_ID,
  email: 'dana@example.com',
  base_currency: 'USD',
  timezone: 'Asia/Jerusalem',
  role: 'user' as const,
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
  getSessionUser: vi.fn(async (userId: string) => (await import('./session.js')).mockedSessionUser(userId)),
  getUser: vi.fn(),
  getUserCredentialsByEmail: vi.fn(),
  createSession: vi.fn(),
  deleteSession: vi.fn(async () => true),
  getPasswordHash: vi.fn(),
  recordSignIn: vi.fn(async () => undefined),
  changePassword: vi.fn(),
  emailInUse: vi.fn(async () => false),
  setPendingEmail: vi.fn(async () => undefined),
  issueAuthToken: vi.fn(async () => undefined),
  changeTimeZone: vi.fn(),
  getOrCreateUserSettings: vi.fn(async () => ({ language: 'en' })),
  insertAdminAudit: vi.fn(),
}));

const { createApp } = await import('../src/http/app.js');
const { loadConfig, resetConfigForTests } = await import('../src/config.js');
const { SESSION_COOKIE, sessionTokenHash, verifySessionToken } = await import('../src/http/auth.js');
const { SESSIONS_PER_USER_MAX, USER_AGENT_MAX_LENGTH } = await import('../src/http/sessions.js');
const { EMAIL_UNVERIFIED } = await import('../src/http/routes/auth.js');
const { RecordingEmailSender } = await import('./recordingEmailSender.js');
const { memoryRateLimits } = await import('../src/http/rateLimits.js');
const { linkTokenHash } = await import('../src/http/linkTokens.js');
const { hashPassword, PASSWORD_MIN_LENGTH } = await import('../src/http/password.js');
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

/** The row `createSession` makes; its expiry is what the cookie must carry. */
const NEW_SESSION = {
  id: '5e551000-0000-4000-8000-0000000000aa',
  // Whole seconds, as a cookie's Expires is; within the 400 days a browser accepts.
  expires_at: new Date(Math.floor(Date.now() / 1000) * 1000 + 7 * 24 * 3600 * 1000),
};

function buildApp() {
  resetConfigForTests();
  return createApp(loadConfig(ENV), createFakeAi());
}

type App = ReturnType<typeof buildApp>;

let passwordHash: string;

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
});

function login(app: App, email: string, password: string) {
  return app.request('/auth/login', {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ email, password }),
  });
}

function changePassword(app: App, cookie: string, currentPassword: string, newPassword: string) {
  return app.request('/auth/password', {
    method: 'POST',
    headers: { ...HEADERS, cookie },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

async function session(app: App, cookie: string) {
  const response = await app.request('/auth/session', { headers: { cookie } });
  return (await response.json()) as { authenticated: boolean; user?: { mustChangePassword: boolean } };
}

/** The `name=value` part of a Set-Cookie header. */
function cookieOf(response: Response): string {
  return (response.headers.get('set-cookie') ?? '').split(';')[0]!;
}

describe('signing in', () => {
  let app: App;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queries.createSession).mockResolvedValue(NEW_SESSION);
    vi.mocked(queries.getUser).mockResolvedValue(USER);
    vi.mocked(queries.getUserCredentialsByEmail).mockResolvedValue({
      id: USER.id,
      status: 'active',
      password_hash: passwordHash,
      session_version: USER.session_version,
      email: USER.email,
      email_verified: true,
    });
    app = buildApp();
  });

  it('issues an httpOnly session cookie carrying the session version', async () => {
    const response = await login(app, 'Dana@Example.com', PASSWORD);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: USER.id, mustChangePassword: false });

    const header = response.headers.get('set-cookie') ?? '';
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    const token = cookieOf(response).slice(`${SESSION_COOKIE}=`.length);
    const claim = verifySessionToken(token, 'test-session-secret-value');
    expect(claim).toEqual({ secret: expect.any(String), userId: USER.id, sessionVersion: USER.session_version });
    expect(queries.getUserCredentialsByEmail).toHaveBeenCalledWith('Dana@Example.com');
    expect(queries.recordSignIn).toHaveBeenCalledWith(USER.id);
    expect((await session(app, cookieOf(response))).authenticated).toBe(true);
  });

  it("writes a session row holding only the hash of the cookie's secret, and expires with it (D261, D295)", async () => {
    const response = await app.request('/auth/login', {
      method: 'POST',
      headers: { ...HEADERS, 'user-agent': 'Mozilla/5.0 (iPhone) Safari/604.1' },
      body: JSON.stringify({ email: USER.email, password: PASSWORD }),
    });
    expect(response.status).toBe(200);
    const claim = verifySessionToken(cookieOf(response).slice(`${SESSION_COOKIE}=`.length), 'test-session-secret-value')!;
    const config = loadConfig(ENV);
    expect(queries.createSession).toHaveBeenCalledWith({
      userId: USER.id,
      tokenHash: sessionTokenHash(claim.secret),
      ttlHours: config.SESSION_TTL_HOURS,
      userAgent: 'Mozilla/5.0 (iPhone) Safari/604.1',
      ipAddress: null,
      maxPerUser: SESSIONS_PER_USER_MAX,
    });
    const created = vi.mocked(queries.createSession).mock.calls[0]![0];
    expect(created.tokenHash.toString('base64url')).not.toContain(claim.secret);
    expect(response.headers.get('set-cookie')).toContain(`Expires=${NEW_SESSION.expires_at.toUTCString()}`);
  });

  it('keeps a user agent no longer than the column allows', async () => {
    await app.request('/auth/login', {
      method: 'POST',
      headers: { ...HEADERS, 'user-agent': 'x'.repeat(USER_AGENT_MAX_LENGTH * 2) },
      body: JSON.stringify({ email: USER.email, password: PASSWORD }),
    });
    expect(vi.mocked(queries.createSession).mock.calls[0]![0].userAgent).toHaveLength(USER_AGENT_MAX_LENGTH);
  });

  it('gives each sign-in its own session', async () => {
    const first = cookieOf(await login(app, USER.email, PASSWORD));
    const second = cookieOf(await login(app, USER.email, PASSWORD));
    expect(first).not.toBe(second);
    const hashes = vi.mocked(queries.createSession).mock.calls.map(([session]) => session.tokenHash.toString('hex'));
    expect(new Set(hashes).size).toBe(2);
  });

  it('opens no session when the password changed while it was being checked (D297)', async () => {
    // Read before argon2 at version 1; the change committed meanwhile, so the user read after it is at 2.
    vi.mocked(queries.getUser).mockResolvedValue({ ...USER, session_version: USER.session_version + 1 });
    const response = await login(app, USER.email, PASSWORD);
    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(queries.createSession).not.toHaveBeenCalled();
  });

  it("ends the session this browser already had when it signs in again", async () => {
    const response = await app.request('/auth/login', {
      method: 'POST',
      headers: { ...HEADERS, cookie: sessionCookie() },
      body: JSON.stringify({ email: USER.email, password: PASSWORD }),
    });
    expect(response.status).toBe(200);
    expect(queries.deleteSession).toHaveBeenCalledWith(USER.id, TEST_SESSION_ID);
    expect(queries.createSession).toHaveBeenCalledOnce();
  });

  it('marks the cookie Secure in production, and only there (D256)', async () => {
    const plain = (await login(app, USER.email, PASSWORD)).headers.get('set-cookie') ?? '';
    expect(plain).not.toContain('Secure');

    resetConfigForTests();
    const production = createApp(loadConfig({ ...ENV, APP_ENV: 'production' }), createFakeAi());
    const header = (await login(production, USER.email, PASSWORD)).headers.get('set-cookie') ?? '';
    expect(header).toContain('Secure');
    expect(header).toContain('HttpOnly');
  });

  it('gives a wrong password and an unknown email the same answer', async () => {
    const wrong = await login(app, USER.email, 'not the password at all');
    vi.mocked(queries.getUserCredentialsByEmail).mockResolvedValue(null);
    const unknown = await login(app, 'nobody@example.com', PASSWORD);

    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    const strip = ({ requestId: _, ...body }: Record<string, unknown>) => body;
    expect(strip(await wrong.json())).toEqual(strip(await unknown.json()));
    expect(wrong.headers.get('set-cookie')).toBeNull();
    expect(queries.recordSignIn).not.toHaveBeenCalled();
  });

  it('refuses a user who has never been given a password', async () => {
    vi.mocked(queries.getUserCredentialsByEmail).mockResolvedValue({
      id: USER.id,
      status: 'active',
      password_hash: null,
      session_version: USER.session_version,
      email: USER.email,
      email_verified: true,
    });
    expect((await login(app, USER.email, PASSWORD)).status).toBe(401);
  });

  it('tells an unverified request with the right password to confirm its email first (D306)', async () => {
    vi.mocked(queries.getUserCredentialsByEmail).mockResolvedValue({
      id: USER.id,
      status: 'pending',
      password_hash: passwordHash,
      session_version: USER.session_version,
      email: USER.email,
      email_verified: false,
    });
    const response = await login(app, USER.email, PASSWORD);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: EMAIL_UNVERIFIED });
    expect(response.headers.get('set-cookie')).toBeNull();
    // A wrong password says nothing about it: the same answer as for any account.
    expect((await login(app, USER.email, 'not the password at all')).status).toBe(401);
  });

  it.each([
    ['pending', 'account_pending'],
    ['rejected', 'account_not_active'],
    ['disabled', 'account_not_active'],
  ] as const)(
    'tells a %s user with the right password %s (D187)',
    async (status, code) => {
      vi.mocked(queries.getUserCredentialsByEmail).mockResolvedValue({
        id: USER.id,
        status,
        password_hash: passwordHash,
        session_version: USER.session_version,
        email: USER.email,
        email_verified: true,
      });
      const response = await login(app, USER.email, PASSWORD);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: code });
      expect(response.headers.get('set-cookie')).toBeNull();
    },
  );
});

describe('a session is checked against the user on every request (D160)', () => {
  let app: App;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queries.createSession).mockResolvedValue(NEW_SESSION);
    app = buildApp();
  });

  it('holds while the user is active and the versions match', async () => {
    vi.mocked(queries.getUser).mockResolvedValue(USER);
    expect((await session(app, sessionCookie())).authenticated).toBe(true);
  });

  it.each(['pending', 'rejected', 'disabled'] as const)('ends once the user is %s', async (status) => {
    vi.mocked(queries.getUser).mockResolvedValue({ ...USER, status });
    expect((await session(app, sessionCookie())).authenticated).toBe(false);
    expect((await app.request('/settings', { headers: { cookie: sessionCookie() } })).status).toBe(401);
  });

  it('ends once the version moves on - a password changed elsewhere', async () => {
    vi.mocked(queries.getUser).mockResolvedValue({ ...USER, session_version: 2 });
    expect((await session(app, sessionCookie(USER.id, 1))).authenticated).toBe(false);
    expect((await session(app, sessionCookie(USER.id, 2))).authenticated).toBe(true);
  });

  it('ends when the user no longer exists', async () => {
    vi.mocked(queries.getUser).mockResolvedValue(null);
    expect((await session(app, sessionCookie())).authenticated).toBe(false);
  });

  it("ends once the session's row is gone - signed out, here or from another device (D261)", async () => {
    vi.mocked(queries.getUser).mockResolvedValue(USER);
    vi.mocked(queries.getSessionUser).mockResolvedValueOnce(null);
    expect((await session(app, sessionCookie())).authenticated).toBe(false);
  });

  it("looks the session up by the hash of the cookie's secret, for the cookie's user", async () => {
    vi.mocked(queries.getUser).mockResolvedValue(USER);
    const { SESSION_TOUCH_INTERVAL_SECONDS } = await import('../src/http/sessions.js');
    await session(app, sessionCookie(USER.id, 1, 'this-devices-secret'));
    expect(queries.getSessionUser).toHaveBeenCalledWith(
      USER.id,
      sessionTokenHash('this-devices-secret'),
      SESSION_TOUCH_INTERVAL_SECONDS,
    );
  });

  it('reads no session for a request without a cookie', async () => {
    await app.request('/auth/session');
    expect(queries.getSessionUser).not.toHaveBeenCalled();
    expect(queries.getUser).not.toHaveBeenCalled();
  });
});

describe('signing out (D261)', () => {
  let app: App;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queries.createSession).mockResolvedValue(NEW_SESSION);
    vi.mocked(queries.getUser).mockResolvedValue(USER);
    app = buildApp();
  });

  function logout(cookie?: string) {
    return app.request('/auth/logout', { method: 'POST', headers: { ...HEADERS, ...(cookie ? { cookie } : {}) } });
  }

  it("deletes this device's session row and the browser's cookie", async () => {
    const response = await logout(sessionCookie());
    expect(response.status).toBe(200);
    expect(queries.deleteSession).toHaveBeenCalledWith(USER.id, TEST_SESSION_ID);
    expect(response.headers.get('set-cookie')).toMatch(new RegExp(`^${SESSION_COOKIE}=;`));
  });

  it('only deletes the cookie when there is no session to end', async () => {
    const response = await logout();
    expect(response.status).toBe(200);
    expect(queries.deleteSession).not.toHaveBeenCalled();
    expect(response.headers.get('set-cookie')).toMatch(new RegExp(`^${SESSION_COOKIE}=;`));
  });
});

describe('the one-time password (D162)', () => {
  let app: App;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queries.createSession).mockResolvedValue(NEW_SESSION);
    vi.mocked(queries.getUser).mockResolvedValue({ ...USER, password_must_change: true });
    app = buildApp();
  });

  it('allows nothing but the session and a password change until it is changed', async () => {
    const cookie = sessionCookie();
    expect((await session(app, cookie)).user?.mustChangePassword).toBe(true);
    const refused = await app.request('/settings', { headers: { cookie } });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: 'password_change_required' });
    const admin = await app.request('/admin/runs', { headers: { cookie } });
    expect(admin.status).toBe(403);
    // Research spends the model: it waits for the password like everything else (D254).
    expect((await app.request('/research', { headers: { cookie } })).status).toBe(403);
  });
});

describe('changing one\'s own password', () => {
  let app: App;
  const NEW_PASSWORD = 'a new and longer passphrase';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queries.createSession).mockResolvedValue(NEW_SESSION);
    vi.mocked(queries.getUser).mockResolvedValue(USER);
    vi.mocked(queries.getPasswordHash).mockResolvedValue(passwordHash);
    vi.mocked(queries.changePassword).mockResolvedValue({
      ...USER,
      session_version: USER.session_version + 1,
    });
    app = buildApp();
  });

  it('needs a session', async () => {
    const response = await app.request('/auth/password', {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
    });
    expect(response.status).toBe(401);
  });

  it('needs the current password', async () => {
    const response = await changePassword(app, sessionCookie(), 'not the password at all', NEW_PASSWORD);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'incorrect_password' });
    expect(queries.changePassword).not.toHaveBeenCalled();
  });

  it('refuses a new password shorter than the rule, or the same one', async () => {
    const short = await changePassword(app, sessionCookie(), PASSWORD, 'x'.repeat(PASSWORD_MIN_LENGTH - 1));
    expect(await short.json()).toMatchObject({ error: 'password_too_short' });
    const same = await changePassword(app, sessionCookie(), PASSWORD, PASSWORD);
    expect(await same.json()).toMatchObject({ error: 'password_unchanged' });
    expect(queries.changePassword).not.toHaveBeenCalled();
  });

  it('stores an argon2id hash and gives this device a new session at the new version', async () => {
    const response = await changePassword(app, sessionCookie(), PASSWORD, NEW_PASSWORD);
    expect(response.status).toBe(200);

    const [userId, storedHash] = vi.mocked(queries.changePassword).mock.calls[0]!;
    expect(userId).toBe(USER.id);
    expect(storedHash).toMatch(/^\$argon2id\$/);

    const token = cookieOf(response).slice(`${SESSION_COOKIE}=`.length);
    expect(verifySessionToken(token, 'test-session-secret-value')?.sessionVersion).toBe(
      USER.session_version + 1,
    );
    // `changePassword` deleted every row in the same statement; this is the new one.
    expect(queries.createSession).toHaveBeenCalledWith(expect.objectContaining({ userId: USER.id }));
  });
});

describe("changing one's own email (D259)", () => {
  let app: App;
  let mail: InstanceType<typeof RecordingEmailSender>;
  const NEW_EMAIL = 'dana.levi@example.com';

  function changeEmail(cookie: string, email: string, currentPassword: string) {
    return app.request('/auth/email', {
      method: 'POST',
      headers: { ...HEADERS, cookie },
      body: JSON.stringify({ email, currentPassword }),
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queries.createSession).mockResolvedValue(NEW_SESSION);
    vi.mocked(queries.getUser).mockResolvedValue(USER);
    vi.mocked(queries.getPasswordHash).mockResolvedValue(passwordHash);
    resetConfigForTests();
    mail = new RecordingEmailSender();
    app = createApp(loadConfig(ENV), createFakeAi(), undefined, null, memoryRateLimits(), mail);
  });

  it('needs a session', async () => {
    const response = await app.request('/auth/email', {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ email: NEW_EMAIL, currentPassword: PASSWORD }),
    });
    expect(response.status).toBe(401);
  });

  it('needs the current password', async () => {
    const response = await changeEmail(sessionCookie(), NEW_EMAIL, 'not the password at all');
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'incorrect_password' });
    expect(queries.setPendingEmail).not.toHaveBeenCalled();
    expect(mail.sent).toEqual([]);
  });

  it('waits for the one-time password to be changed (D162)', async () => {
    vi.mocked(queries.getUser).mockResolvedValue({ ...USER, password_must_change: true });
    const response = await changeEmail(sessionCookie(), NEW_EMAIL, PASSWORD);
    expect(await response.json()).toMatchObject({ error: 'password_change_required' });
    expect(queries.setPendingEmail).not.toHaveBeenCalled();
  });

  it('refuses an address that is not one, or the current one in another case', async () => {
    const invalid = await changeEmail(sessionCookie(), 'Dana Levi', PASSWORD);
    expect(await invalid.json()).toMatchObject({ error: 'email_invalid' });
    const same = await changeEmail(sessionCookie(), ' DANA@example.com ', PASSWORD);
    expect(await same.json()).toMatchObject({ error: 'email_unchanged' });
    expect(queries.setPendingEmail).not.toHaveBeenCalled();
  });

  it('refuses an address another account uses, to someone who knows this password', async () => {
    vi.mocked(queries.emailInUse).mockResolvedValueOnce(true);
    const response = await changeEmail(sessionCookie(), NEW_EMAIL, PASSWORD);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'email_taken' });
    expect(mail.sent).toEqual([]);
  });

  it('keeps the current address and this session, stores the new one as pending, and mails both', async () => {
    vi.mocked(queries.getUser).mockResolvedValueOnce(USER).mockResolvedValue({ ...USER, pending_email: NEW_EMAIL });
    const response = await changeEmail(sessionCookie(), '  Dana.Levi@Example.com ', PASSWORD);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ email: USER.email, pendingEmail: NEW_EMAIL });
    expect(queries.setPendingEmail).toHaveBeenCalledWith(USER.id, NEW_EMAIL);
    expect(response.headers.get('set-cookie')).toBeNull();

    await mail.settled();
    const token = mail.tokenSentTo(NEW_EMAIL)!;
    expect(queries.issueAuthToken).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER.id, purpose: 'verify_new_email', email: NEW_EMAIL, tokenHash: linkTokenHash(token) }),
    );
    const notice = mail.sent.find((sent) => sent.to === USER.email)!;
    expect(notice.text).toContain(NEW_EMAIL);
    expect(notice.text).not.toContain('#token=');
  });

  it('refuses where no mail can be sent: the new address could never be confirmed', async () => {
    resetConfigForTests();
    const noMail = createApp(loadConfig(ENV), createFakeAi(), undefined, null, memoryRateLimits(), null);
    const response = await noMail.request('/auth/email', {
      method: 'POST',
      headers: { ...HEADERS, cookie: sessionCookie() },
      body: JSON.stringify({ email: NEW_EMAIL, currentPassword: PASSWORD }),
    });
    expect(response.status).toBe(503);
    expect(queries.setPendingEmail).not.toHaveBeenCalled();
  });
});

describe("changing one's own time zone (D163)", () => {
  let app: App;

  function changeZone(cookie: string | null, timezone: unknown) {
    return app.request('/auth/timezone', {
      method: 'POST',
      headers: cookie ? { ...HEADERS, cookie } : HEADERS,
      body: JSON.stringify({ timezone }),
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queries.createSession).mockResolvedValue(NEW_SESSION);
    vi.mocked(queries.getUser).mockResolvedValue(USER);
    vi.mocked(queries.changeTimeZone).mockResolvedValue({ ...USER, timezone: 'Europe/London' });
    app = buildApp();
  });

  it('needs a session', async () => {
    expect((await changeZone(null, 'Europe/London')).status).toBe(401);
  });

  it('accepts only an IANA zone', async () => {
    for (const zone of ['Mars/Olympus', 'not a zone', '', 7]) {
      const response = await changeZone(sessionCookie(), zone);
      expect(response.status, String(zone)).toBe(400);
    }
    expect(queries.changeTimeZone).not.toHaveBeenCalled();
  });

  it('stores the zone and answers the session user, without ending the session', async () => {
    const response = await changeZone(sessionCookie(), 'Europe/London');
    expect(response.status).toBe(200);
    expect(queries.changeTimeZone).toHaveBeenCalledWith(USER.id, 'Europe/London');
    expect(await response.json()).toMatchObject({ timezone: 'Europe/London' });
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('waits for the one-time password to be changed (D162)', async () => {
    vi.mocked(queries.getUser).mockResolvedValue({ ...USER, password_must_change: true });
    const response = await changeZone(sessionCookie(), 'Europe/London');
    expect(await response.json()).toMatchObject({ error: 'password_change_required' });
  });
});
