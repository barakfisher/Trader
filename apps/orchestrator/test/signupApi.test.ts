/**
 * Asking to join, proving the address, a new link from sign-in, and the
 * admin's decision on the Admin page (D156, D185-D188, D243, D259, D303-D306).
 * The database and the Telegram announcement are mocked; the hashing is real,
 * and mail is recorded rather than sent (D258).
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
  getSessionUser: vi.fn(async (userId: string) => (await import('./session.js')).mockedSessionUser(userId)),
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
  issueAuthToken: vi.fn(async () => undefined),
  useVerificationToken: vi.fn(),
  peekVerificationToken: vi.fn(),
  getUserCredentialsByEmail: vi.fn(),
  createSession: vi.fn(async () => ({ id: '5e551000-0000-4000-8000-0000000000cc', expires_at: new Date(Date.now() + 3_600_000) })),
}));

vi.mock('../src/telegram/signupApproval.js', () => ({ announceSignupRequest: vi.fn(async () => undefined) }));

const { createApp } = await import('../src/http/app.js');
const { loadConfig, resetConfigForTests } = await import('../src/config.js');
const { passwordMatches } = await import('../src/http/password.js');
const { announceSignupRequest } = await import('../src/telegram/signupApproval.js');
const queries = await import('../src/db/queries.js');
const { createFakeAi } = await import('./fakeAi.js');
const { memoryRateLimits } = await import('../src/http/rateLimits.js');
const { linkTokenHash, VERIFY_TOKEN_TTL_HOURS } = await import('../src/http/linkTokens.js');
const { RecordingEmailSender } = await import('./recordingEmailSender.js');
const { emailMessages } = await import('../src/email/messages.js');

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

let mail = new RecordingEmailSender();

/** The app with a recording sender; `withEmail: false` is an installation with no SMTP configured. */
function buildApp({ withEmail = true } = {}) {
  resetConfigForTests();
  mail = new RecordingEmailSender();
  return createApp(loadConfig(ENV), createFakeAi(), undefined, null, memoryRateLimits(), withEmail ? mail : null);
}

type App = ReturnType<typeof buildApp>;

const REQUEST = { email: ' Noa@Example.com ', password: PASSWORD, timezone: 'Europe/London', language: 'he' };

function signup(app: App, body: unknown = REQUEST) {
  return app.request('/auth/signup', { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });
}

describe('asking to join (D156, D185, D259, D303)', () => {
  let app: App;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp();
  });

  it("writes an unverified request with a real hash and mails its link - the admin hears nothing yet", async () => {
    vi.mocked(queries.createSignupRequest).mockResolvedValue({ outcome: 'created', userId: REQUESTER });
    const response = await signup(app);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: 'received' });

    const input = vi.mocked(queries.createSignupRequest).mock.calls[0]![0];
    expect(input).toMatchObject({ email: 'noa@example.com', timezone: 'Europe/London', language: 'he' });
    expect(await passwordMatches(PASSWORD, input.passwordHash)).toBe(true);
    await mail.settled();
    expect(mail.sent.map((sent) => sent.to)).toEqual(['noa@example.com']);
    const token = mail.tokenSentTo('noa@example.com')!;
    // A sign-up's link says so, for the page to ask for the password (D309).
    expect(mail.sent[0]!.text).toContain(`http://localhost:5173/verify#token=${token}&for=signup`);
    expect(mail.sent[0]!.html).toContain('dir="rtl"');
    expect(queries.issueAuthToken).toHaveBeenCalledWith({
      userId: REQUESTER,
      purpose: 'verify_email',
      email: 'noa@example.com',
      tokenHash: linkTokenHash(token),
      ttlMinutes: VERIFY_TOKEN_TTL_HOURS * 60,
    });
    expect(announceSignupRequest).not.toHaveBeenCalled();
  });

  it('answers an existing account exactly as a new address, and tells the owner by mail (D303)', async () => {
    vi.mocked(queries.createSignupRequest).mockResolvedValue({
      outcome: 'exists',
      userId: REQUESTER,
      status: 'active',
      verified: true,
      language: 'en',
    });
    const response = await signup(app);
    expect(await response.json()).toEqual({ outcome: 'received' });
    await mail.settled();
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ to: 'noa@example.com', subject: 'Someone tried to sign up to TikLens with your address' });
    expect(mail.sent[0]!.text).not.toContain('#token=');
    expect(queries.issueAuthToken).not.toHaveBeenCalled();
    expect(announceSignupRequest).not.toHaveBeenCalled();
  });

  it('sends a request still waiting for its link a fresh one, as a retry', async () => {
    vi.mocked(queries.createSignupRequest).mockResolvedValue({
      outcome: 'exists',
      userId: REQUESTER,
      status: 'pending',
      verified: false,
      language: 'he',
    });
    await signup(app);
    await mail.settled();
    expect(mail.tokenSentTo('noa@example.com')).not.toBeNull();
    expect(queries.issueAuthToken).toHaveBeenCalledWith(expect.objectContaining({ userId: REQUESTER, purpose: 'verify_email' }));
  });

  it('still answers received when the mail cannot be sent, and says nothing about why', async () => {
    vi.mocked(queries.createSignupRequest).mockResolvedValue({ outcome: 'created', userId: REQUESTER });
    mail.failWith = new Error('SMTP refused');
    const response = await signup(app);
    expect(await response.json()).toEqual({ outcome: 'received' });
  });

  it('says sign-up is closed while it is closed, mailing nobody', async () => {
    vi.mocked(queries.createSignupRequest).mockResolvedValue({ outcome: 'closed' });
    const response = await signup(app);
    expect(await response.json()).toEqual({ outcome: 'closed' });
    await mail.settled();
    expect(mail.sent).toEqual([]);
  });

  it('is closed where no mail can be sent: no address could ever be proven (D259)', async () => {
    const closed = buildApp({ withEmail: false });
    const response = await signup(closed);
    expect(await response.json()).toEqual({ outcome: 'closed' });
    expect(queries.createSignupRequest).not.toHaveBeenCalled();
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

describe('opening a verification link (D259, D260, D309)', () => {
  let app: App;
  let passwordHash: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(queries.getInstallationSettings).mockResolvedValue({
      default_llm_cap_micro_usd: 10_000_000,
      signup_mode: 'automatic',
      daily_new_accounts_limit: 20,
      max_pending_signups: 50,
    } as never);
    const { hashPassword } = await import('../src/http/password.js');
    passwordHash = await hashPassword(PASSWORD);
    // An address change's link by default; it needs the account's password too (D310).
    vi.mocked(queries.peekVerificationToken).mockResolvedValue({
      purpose: 'verify_new_email',
      accountEmail: 'noa@example.com',
      passwordHash,
      open: true,
    });
    app = buildApp();
  });

  /** A sign-up's open link, whose request was made with PASSWORD. */
  const signupLink = () =>
    vi.mocked(queries.peekVerificationToken).mockResolvedValue({
      purpose: 'verify_email',
      accountEmail: 'noa@example.com',
      passwordHash,
      open: true,
    });

  const verify = (body: unknown) =>
    app.request('/auth/verify', { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });

  it("hands the token's hash and the installation's rules to the database, and says what happened", async () => {
    vi.mocked(queries.useVerificationToken).mockResolvedValue({ outcome: 'activated', userId: REQUESTER });
    const response = await verify({ token: 'the-token', password: PASSWORD });
    expect(await response.json()).toEqual({ outcome: 'activated' });
    expect(queries.useVerificationToken).toHaveBeenCalledWith(
      linkTokenHash('the-token'),
      { defaultCapMicroUsd: 10_000_000, timezone: loadConfig(ENV).APP_TIMEZONE, automaticHeld: false },
      { passwordHash },
    );
    expect(announceSignupRequest).not.toHaveBeenCalled();
    // A link proves the mailbox; it is not the password, so it opens no session.
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('announces a request to the admin only once its address is proven and it waits for them', async () => {
    vi.mocked(queries.useVerificationToken).mockResolvedValue({ outcome: 'awaiting_approval', userId: REQUESTER });
    const response = await verify({ token: 'the-token', password: PASSWORD });
    expect(await response.json()).toEqual({ outcome: 'awaiting_approval' });
    expect(announceSignupRequest).toHaveBeenCalledWith(expect.anything(), REQUESTER);
  });

  it('gives this device a new session when it confirms its own new address - and no other device', async () => {
    vi.mocked(queries.useVerificationToken).mockResolvedValue({ outcome: 'email_changed', userId: TEST_USER_ID });
    vi.mocked(queries.getUser).mockResolvedValue({ ...ADMIN, role: 'user' } as never);
    const here = await app.request('/auth/verify', {
      method: 'POST',
      headers: { ...HEADERS, cookie: sessionCookie() },
      body: JSON.stringify({ token: 'the-token', password: PASSWORD }),
    });
    expect(await here.json()).toEqual({ outcome: 'email_changed' });
    expect(here.headers.get('set-cookie')).toContain('traders_session=');

    vi.mocked(queries.useVerificationToken).mockResolvedValue({ outcome: 'email_changed', userId: REQUESTER });
    const elsewhere = await verify({ token: 'the-token', password: PASSWORD });
    expect(elsewhere.headers.get('set-cookie')).toBeNull();
  });

  it("opens a sign-up's link only with its password, and hands the database the hash it checked", async () => {
    signupLink();
    vi.mocked(queries.useVerificationToken).mockResolvedValue({ outcome: 'activated', userId: REQUESTER });
    expect(await (await verify({ token: 'the-token' })).json()).toEqual({ outcome: 'wrong_password' });
    expect(await (await verify({ token: 'the-token', password: 'not the password' })).json()).toEqual({
      outcome: 'wrong_password',
    });
    expect(queries.useVerificationToken).not.toHaveBeenCalled();
    expect(await (await verify({ token: 'the-token', password: PASSWORD })).json()).toEqual({ outcome: 'activated' });
    expect(queries.useVerificationToken).toHaveBeenCalledWith(linkTokenHash('the-token'), expect.anything(), { passwordHash });
  });

  it('counts wrong passwords on a link as failed sign-ins, and refuses once they are spent', async () => {
    signupLink();
    const { RATE_LIMITS } = await import('../src/http/rateLimits.js');
    const allowed = RATE_LIMITS.loginFailuresPerAccount.points;
    for (let attempt = 0; attempt < allowed; attempt += 1) {
      expect((await verify({ token: 'the-token', password: 'not the password' })).status).toBe(200);
    }
    expect((await verify({ token: 'the-token', password: PASSWORD })).status).toBe(429);
  });

  it("asks an address change's link for the account's password too (D310)", async () => {
    vi.mocked(queries.useVerificationToken).mockResolvedValue({ outcome: 'email_changed', userId: REQUESTER });
    expect(await (await verify({ token: 'the-token' })).json()).toEqual({ outcome: 'wrong_password' });
    expect(await (await verify({ token: 'the-token', password: 'not the password' })).json()).toEqual({
      outcome: 'wrong_password',
    });
    expect(queries.useVerificationToken).not.toHaveBeenCalled();
  });

  it('asks no password of a used or expired link, so it can say which it is', async () => {
    vi.mocked(queries.peekVerificationToken).mockResolvedValue({
      purpose: 'verify_email',
      accountEmail: 'noa@example.com',
      passwordHash,
      open: false,
    });
    vi.mocked(queries.useVerificationToken).mockResolvedValue({ outcome: 'expired' });
    expect(await (await verify({ token: 'the-token' })).json()).toEqual({ outcome: 'expired' });
  });

  it.each(['expired', 'used', 'invalid', 'signup_full'] as const)('passes %s through, changing nothing else', async (outcome) => {
    vi.mocked(queries.useVerificationToken).mockResolvedValue({ outcome });
    expect(await (await verify({ token: 'the-token', password: PASSWORD })).json()).toEqual({ outcome });
    expect(announceSignupRequest).not.toHaveBeenCalled();
  });

  it('calls a malformed request an invalid link, without asking the database', async () => {
    expect(await (await verify({})).json()).toEqual({ outcome: 'invalid' });
    expect(queries.useVerificationToken).not.toHaveBeenCalled();
  });
});

describe('a new link, asked from sign-in (D306)', () => {
  let app: App;
  let passwordHash: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { hashPassword } = await import('../src/http/password.js');
    passwordHash = await hashPassword(PASSWORD);
    app = buildApp();
  });

  const resend = (password = PASSWORD) =>
    app.request('/auth/verify/resend', {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ email: 'noa@example.com', password }),
    });

  const unverified = () => ({
    id: REQUESTER,
    status: 'pending' as const,
    password_hash: passwordHash,
    session_version: 1,
    email: 'noa@example.com',
    email_verified: false,
  });

  it('mails a new link to an unverified request whose password is right', async () => {
    vi.mocked(queries.getUserCredentialsByEmail).mockResolvedValue(unverified());
    const response = await resend();
    expect(response.status).toBe(200);
    expect(mail.tokenSentTo('noa@example.com')).not.toBeNull();
  });

  it('answers a wrong password as a sign-in would, mailing nothing', async () => {
    vi.mocked(queries.getUserCredentialsByEmail).mockResolvedValue(unverified());
    const response = await resend('not the password at all');
    expect(response.status).toBe(401);
    expect(mail.sent).toEqual([]);
  });

  it('sends nothing to an account that is not waiting for a link', async () => {
    vi.mocked(queries.getUserCredentialsByEmail).mockResolvedValue({ ...unverified(), status: 'active', email_verified: true });
    const response = await resend();
    expect(response.status).toBe(409);
    expect(mail.sent).toEqual([]);
  });

  it('stops after a few links an hour', async () => {
    vi.mocked(queries.getUserCredentialsByEmail).mockResolvedValue(unverified());
    const { RATE_LIMITS } = await import('../src/http/rateLimits.js');
    for (let i = 0; i < RATE_LIMITS.verificationResendPerAccount.points; i += 1) expect((await resend()).status).toBe(200);
    expect((await resend()).status).toBe(429);
    expect(mail.sent).toHaveLength(RATE_LIMITS.verificationResendPerAccount.points);
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

  it('mails the approved person once, in their language, with a link to sign in (D344)', async () => {
    vi.mocked(queries.approveSignup).mockResolvedValue({ applied: true, status: 'active', email: 'noa@example.com' });
    vi.mocked(queries.getOrCreateUserSettings).mockResolvedValueOnce({ language: 'he' } as never);
    await post(`/admin/signups/${REQUESTER}/approve`, {});
    await mail.settled();
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ to: 'noa@example.com', subject: emailMessages.signupApproved('x', 'he', 'x').subject });
    expect(mail.sent[0]!.text).toContain('http://localhost:5173/');
    expect(mail.sent[0]!.html).toContain('dir="rtl"');
    expect(queries.getOrCreateUserSettings).toHaveBeenCalledWith(REQUESTER);
  });

  it('mails nobody when the approval did not apply, or on a rejection (D344)', async () => {
    vi.mocked(queries.approveSignup).mockResolvedValue({ applied: false, status: 'active', email: 'noa@example.com' });
    await post(`/admin/signups/${REQUESTER}/approve`, {});
    vi.mocked(queries.rejectSignup).mockResolvedValue({ applied: true, status: 'rejected', email: 'noa@example.com' });
    expect(await (await post(`/admin/signups/${REQUESTER}/reject`)).json()).toEqual({ applied: true, status: 'rejected' });
    await mail.settled();
    expect(mail.sent).toEqual([]);
  });

  it('approves even when the mail fails, and logs it by user id, never the address (D344)', async () => {
    const { logger } = await import('../src/logger.js');
    const logged = vi.spyOn(logger(), 'error');
    vi.mocked(queries.approveSignup).mockResolvedValue({ applied: true, status: 'active', email: 'noa@example.com' });
    mail.failWith = new Error('550 refused for noa@example.com');
    const response = await post(`/admin/signups/${REQUESTER}/approve`, {});
    expect(await response.json()).toEqual({ applied: true, status: 'active' });
    await mail.settled();
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ userId: REQUESTER, mail: 'signup_approved' }), 'mail not sent');
    expect(JSON.stringify(logged.mock.calls)).not.toContain('noa@example.com');
    logged.mockRestore();
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
