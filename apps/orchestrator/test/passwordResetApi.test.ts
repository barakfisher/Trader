/**
 * A forgotten password (D260, D312): asking for a reset link, opening it, and
 * the notice every password change sends. The database is mocked; the hashing
 * is real, and mail is recorded rather than sent (D258).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ACTIVE_SESSION, TEST_USER_ID, sessionCookie } from './session.js';

const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const NEW_PASSWORD = 'a brand new passphrase';

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
  getOrCreateUserSettings: vi.fn(async () => ({ language: 'he' })),
  issueAuthToken: vi.fn(async () => undefined),
  getResetRecipient: vi.fn(),
  useResetToken: vi.fn(),
  peekVerificationToken: vi.fn(),
  getPasswordHash: vi.fn(),
  changePassword: vi.fn(),
  createSession: vi.fn(async () => ({ id: '5e551000-0000-4000-8000-0000000000dd', expires_at: new Date(Date.now() + 3_600_000) })),
}));

const { createApp } = await import('../src/http/app.js');
const { loadConfig, resetConfigForTests } = await import('../src/config.js');
const { hashPassword, passwordMatches } = await import('../src/http/password.js');
const queries = await import('../src/db/queries.js');
const { createFakeAi } = await import('./fakeAi.js');
const { memoryRateLimits, RATE_LIMITS } = await import('../src/http/rateLimits.js');
const { linkTokenHash, RESET_TOKEN_TTL_MINUTES } = await import('../src/http/linkTokens.js');
const { RecordingEmailSender } = await import('./recordingEmailSender.js');

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

function buildApp({ withEmail = true } = {}) {
  resetConfigForTests();
  mail = new RecordingEmailSender();
  return createApp(loadConfig(ENV), createFakeAi(), undefined, null, memoryRateLimits(), withEmail ? mail : null);
}

type App = ReturnType<typeof buildApp>;

const post = (app: App, path: string, body: unknown, headers: Record<string, string> = HEADERS) =>
  app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });

describe('asking for a reset link (D260, D312)', () => {
  let app: App;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp();
  });

  it("mails an active account's proven address a half-hour link, in its language", async () => {
    vi.mocked(queries.getResetRecipient).mockResolvedValue({ id: ACCOUNT, email: 'noa@example.com', language: 'he' });
    const response = await post(app, '/auth/reset/request', { email: ' Noa@Example.com ' });
    expect(await response.json()).toEqual({ sent: true });
    expect(queries.getResetRecipient).toHaveBeenCalledWith('noa@example.com');
    await mail.settled();
    const token = mail.tokenSentTo('noa@example.com')!;
    expect(queries.issueAuthToken).toHaveBeenCalledWith({
      userId: ACCOUNT,
      purpose: 'reset_password',
      email: 'noa@example.com',
      tokenHash: linkTokenHash(token),
      ttlMinutes: RESET_TOKEN_TTL_MINUTES,
    });
    expect(mail.sent[0]!.text).toContain(`http://localhost:5173/reset#token=${token}`);
    expect(mail.sent[0]!.html).toContain('dir="rtl"');
  });

  it('answers exactly the same for an address with no active account, and mails nobody', async () => {
    vi.mocked(queries.getResetRecipient).mockResolvedValue(null);
    const response = await post(app, '/auth/reset/request', { email: 'nobody@example.com' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sent: true });
    await mail.settled();
    expect(mail.sent).toEqual([]);
    expect(queries.issueAuthToken).not.toHaveBeenCalled();
  });

  it('does not look up an address the email rule refuses, and still answers the same', async () => {
    expect(await (await post(app, '/auth/reset/request', { email: 'victim@example.com,attacker' })).json()).toEqual({ sent: true });
    expect(queries.getResetRecipient).not.toHaveBeenCalled();
  });

  it('limits requests per email, so an address cannot be flooded', async () => {
    vi.mocked(queries.getResetRecipient).mockResolvedValue(null);
    for (let request = 0; request < RATE_LIMITS.resetRequestPerEmail.points; request += 1) {
      expect((await post(app, '/auth/reset/request', { email: 'noa@example.com' })).status).toBe(200);
    }
    expect((await post(app, '/auth/reset/request', { email: 'NOA@example.com' })).status).toBe(429);
  });

  it('says where no mail can be sent at all', async () => {
    const response = await post(buildApp({ withEmail: false }), '/auth/reset/request', { email: 'noa@example.com' });
    expect(response.status).toBe(503);
  });
});

describe('opening a reset link (D260, D312)', () => {
  let app: App;

  beforeEach(() => {
    vi.clearAllMocks();
    // An open reset link by default.
    vi.mocked(queries.peekVerificationToken).mockResolvedValue({
      purpose: 'reset_password',
      accountEmail: 'noa@example.com',
      passwordHash: 'stored',
      open: true,
    });
    app = buildApp();
  });

  it('sets a real hash of the new password, mails the notice, and signs nobody in', async () => {
    vi.mocked(queries.useResetToken).mockResolvedValue({ outcome: 'reset', userId: ACCOUNT, email: 'noa@example.com' });
    const response = await post(app, '/auth/reset', { token: 'the-token', newPassword: NEW_PASSWORD });
    expect(await response.json()).toEqual({ outcome: 'reset' });
    const [hash, passwordHash] = vi.mocked(queries.useResetToken).mock.calls[0]!;
    expect(hash).toEqual(linkTokenHash('the-token'));
    expect(await passwordMatches(NEW_PASSWORD, passwordHash)).toBe(true);
    expect(queries.createSession).not.toHaveBeenCalled();
    await mail.settled();
    expect(mail.sent.map((sent) => sent.to)).toEqual(['noa@example.com']);
    expect(mail.sent[0]!.subject).toBe('הסיסמה שלכם ב-TikLens שונתה');
  });

  // argon2 is the expensive part: a made-up token, or a link that cannot be used, must not cost it.
  it('hashes nothing for an unknown or unusable link, and asks the database only what it is', async () => {
    vi.mocked(queries.peekVerificationToken).mockResolvedValue(null);
    vi.mocked(queries.useResetToken).mockResolvedValue({ outcome: 'invalid' });
    expect(await (await post(app, '/auth/reset', { token: 'made-up', newPassword: NEW_PASSWORD })).json()).toEqual({ outcome: 'invalid' });
    expect(queries.useResetToken).toHaveBeenLastCalledWith(linkTokenHash('made-up'), null);
    vi.mocked(queries.peekVerificationToken).mockResolvedValue({
      purpose: 'reset_password',
      accountEmail: 'noa@example.com',
      passwordHash: 'stored',
      open: false,
    });
    vi.mocked(queries.useResetToken).mockResolvedValue({ outcome: 'expired' });
    expect(await (await post(app, '/auth/reset', { token: 'old', newPassword: NEW_PASSWORD })).json()).toEqual({ outcome: 'expired' });
    expect(queries.useResetToken).toHaveBeenLastCalledWith(linkTokenHash('old'), null);
  });

  it('limits new passwords sent from one address', async () => {
    vi.mocked(queries.peekVerificationToken).mockResolvedValue(null);
    vi.mocked(queries.useResetToken).mockResolvedValue({ outcome: 'invalid' });
    for (let attempt = 0; attempt < RATE_LIMITS.resetAttemptPerAddress.points; attempt += 1) {
      expect((await post(app, '/auth/reset', { token: `t${attempt}`, newPassword: NEW_PASSWORD })).status).toBe(200);
    }
    expect((await post(app, '/auth/reset', { token: 'one more', newPassword: NEW_PASSWORD })).status).toBe(429);
  });

  it('refuses a password the rule refuses before touching the link', async () => {
    const response = await post(app, '/auth/reset', { token: 'the-token', newPassword: 'short' });
    expect(response.status).toBe(400);
    expect(queries.useResetToken).not.toHaveBeenCalled();
  });

  it.each(['expired', 'used', 'invalid'] as const)('passes %s through, mailing nobody', async (outcome) => {
    vi.mocked(queries.useResetToken).mockResolvedValue({ outcome });
    expect(await (await post(app, '/auth/reset', { token: 'the-token', newPassword: NEW_PASSWORD })).json()).toEqual({ outcome });
    await mail.settled();
    expect(mail.sent).toEqual([]);
  });

  it('calls a malformed request an invalid link, without asking the database', async () => {
    expect(await (await post(app, '/auth/reset', {})).json()).toEqual({ outcome: 'invalid' });
    expect(queries.useResetToken).not.toHaveBeenCalled();
  });
});

describe('a password changed from Settings (D312)', () => {
  it("mails the account's address that its password changed", async () => {
    vi.clearAllMocks();
    const app = buildApp();
    const me = { ...ACTIVE_SESSION, id: TEST_USER_ID, email: 'me@example.com' };
    vi.mocked(queries.getUser).mockResolvedValue(me as never);
    vi.mocked(queries.getPasswordHash).mockResolvedValue(await hashPassword('the current passphrase'));
    vi.mocked(queries.changePassword).mockResolvedValue({ ...me, session_version: 2 } as never);
    const response = await post(
      app,
      '/auth/password',
      { currentPassword: 'the current passphrase', newPassword: NEW_PASSWORD },
      { ...HEADERS, cookie: sessionCookie() },
    );
    expect(response.status).toBe(200);
    await mail.settled();
    expect(mail.sent.map((sent) => sent.to)).toEqual(['me@example.com']);
  });
});
