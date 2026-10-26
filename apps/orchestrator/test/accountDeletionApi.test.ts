/**
 * Deleting one's own account and exporting its data (D264): what confirms a
 * deletion, what it does at once (sessions, cookie, the email), signing in
 * during the grace period - which reopens a closed account and never a
 * disabled one - the export's limits and contents, and the installation's
 * erase run. The database is mocked; which rows the statements touch is
 * `queries.postgres.test.ts`'s and `test_account_erase_sql.py`'s.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ACCOUNT_DELETION_CONFIRMATION, ACCOUNT_DELETION_GRACE_DAYS } from '@traders/shared';

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

const DUE = new Date('2026-11-02T10:00:00Z');

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
  reopenClosedAccount: vi.fn(),
  closeAccount: vi.fn(),
  sessionSignedInWithin: vi.fn(),
  exportAccount: vi.fn(),
  getOrCreateUserSettings: vi.fn(async () => ({ language: 'en' })),
  getInstallationSettings: vi.fn(),
  listAccountsDueForErase: vi.fn(),
  listRejectedSignupsOlderThan: vi.fn(),
  eraseAccount: vi.fn(),
  claimRun: vi.fn(async () => ({ claimed: true, runId: 'run-1' })),
  finishRun: vi.fn(async () => undefined),
  insertAdminAudit: vi.fn(),
}));

const { createApp } = await import('../src/http/app.js');
const { loadConfig, resetConfigForTests } = await import('../src/config.js');
const { SESSION_COOKIE } = await import('../src/http/auth.js');
const { RecordingEmailSender } = await import('./recordingEmailSender.js');
const { memoryRateLimits, RATE_LIMITS } = await import('../src/http/rateLimits.js');
const { hashPassword } = await import('../src/http/password.js');
const { RECENT_SIGN_IN_MINUTES } = await import('../src/http/routes/accountDeletion.js');
const { REJECTED_SIGNUP_RETENTION_DAYS } = await import('../src/services/accountErase.js');
const { INSTALLATION_KINDS } = await import('../src/runKinds.js');
const { INTERVALS_MS } = await import('../src/scheduler.js');
const { deletionDate } = await import('../src/http/accountMail.js');
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

const ORIGIN = 'http://localhost:5173';
const HEADERS = { origin: ORIGIN, 'content-type': 'application/json' };

let passwordHash: string;
let mail: InstanceType<typeof RecordingEmailSender>;

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
});

function buildApp(email: InstanceType<typeof RecordingEmailSender> | null = mail) {
  resetConfigForTests();
  return createApp(loadConfig(ENV), createFakeAi(), undefined, null, memoryRateLimits(), email);
}

type App = ReturnType<typeof buildApp>;

function deleteAccount(app: App, body: unknown) {
  return app.request('/account/deletion', {
    method: 'POST',
    headers: { ...HEADERS, cookie: sessionCookie() },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mail = new RecordingEmailSender();
  vi.mocked(queries.getUser).mockResolvedValue(USER);
  // One test mails in Hebrew; the rest read English.
  vi.mocked(queries.getOrCreateUserSettings).mockResolvedValue({ language: 'en' } as never);
  vi.mocked(queries.getPasswordHash).mockResolvedValue(passwordHash);
  vi.mocked(queries.sessionSignedInWithin).mockResolvedValue(false);
  vi.mocked(queries.closeAccount).mockResolvedValue({
    id: USER.id,
    email: USER.email,
    timezone: USER.timezone,
    deletion_due_at: DUE,
  });
});

describe('deleting the account (D264)', () => {
  it('closes it for the grace period, ends this session and says when it goes', async () => {
    const app = buildApp();
    const response = await deleteAccount(app, { confirm: ACCOUNT_DELETION_CONFIRMATION, password: PASSWORD });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deletionDueAt: DUE.toISOString() });
    expect(queries.closeAccount).toHaveBeenCalledWith(USER.id, ACCOUNT_DELETION_GRACE_DAYS);
    // The browser's cookie is deleted; the rows went with the close.
    expect(response.headers.get('set-cookie')).toMatch(new RegExp(`^${SESSION_COOKIE}=;`));
  });

  it('mails the account the permanent deletion date at once, in its language and zone', async () => {
    vi.mocked(queries.getOrCreateUserSettings).mockResolvedValue({ language: 'he' } as never);
    const app = buildApp();
    await deleteAccount(app, { confirm: ACCOUNT_DELETION_CONFIRMATION, password: PASSWORD });
    await mail.settled();
    expect(mail.sent).toHaveLength(1);
    const [sent] = mail.sent;
    expect(sent!.to).toBe(USER.email);
    expect(sent!.text).toContain(deletionDate(DUE, 'he', USER.timezone));
    expect(sent!.html).toContain('lang="he"');
    expect(sent!.text).toContain(ORIGIN);
  });

  it('closes nothing without the typed word', async () => {
    const app = buildApp();
    const response = await deleteAccount(app, { confirm: 'delete', password: PASSWORD });
    expect(response.status).toBe(422);
    expect((await response.json()).error).toBe('deletion_not_confirmed');
    expect(queries.closeAccount).not.toHaveBeenCalled();
  });

  it('closes nothing on a wrong password, and counts it against the account as a sign-in', async () => {
    const app = buildApp();
    const limit = RATE_LIMITS.loginFailuresPerAccount.points;
    for (let attempt = 0; attempt < limit; attempt += 1) {
      const response = await deleteAccount(app, { confirm: ACCOUNT_DELETION_CONFIRMATION, password: 'not the password' });
      expect(response.status).toBe(403);
      expect((await response.json()).error).toBe('incorrect_password');
    }
    // The next try is refused before the password is looked at - the right one included.
    const spent = await deleteAccount(app, { confirm: ACCOUNT_DELETION_CONFIRMATION, password: PASSWORD });
    expect(spent.status).toBe(429);
    expect(queries.closeAccount).not.toHaveBeenCalled();
  });

  it('asks an account with a password for it', async () => {
    const app = buildApp();
    const response = await deleteAccount(app, { confirm: ACCOUNT_DELETION_CONFIRMATION });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('password_required');
    expect(queries.closeAccount).not.toHaveBeenCalled();
  });

  it('confirms an account with no password by a sign-in moments ago, and only that', async () => {
    vi.mocked(queries.getPasswordHash).mockResolvedValue(null);
    const app = buildApp();
    const stale = await deleteAccount(app, { confirm: ACCOUNT_DELETION_CONFIRMATION });
    expect(stale.status).toBe(403);
    expect((await stale.json()).error).toBe('sign_in_again');
    expect(queries.sessionSignedInWithin).toHaveBeenCalledWith(USER.id, TEST_SESSION_ID, RECENT_SIGN_IN_MINUTES);
    expect(queries.closeAccount).not.toHaveBeenCalled();

    vi.mocked(queries.sessionSignedInWithin).mockResolvedValue(true);
    const fresh = await deleteAccount(app, { confirm: ACCOUNT_DELETION_CONFIRMATION });
    expect(fresh.status).toBe(200);
  });

  it('never closes the admin', async () => {
    vi.mocked(queries.getUser).mockResolvedValue({ ...USER, role: 'admin' });
    const app = buildApp();
    const response = await deleteAccount(app, { confirm: ACCOUNT_DELETION_CONFIRMATION, password: PASSWORD });
    expect(response.status).toBe(403);
    expect(queries.closeAccount).not.toHaveBeenCalled();
  });

  it('refuses a signed-out request', async () => {
    const app = buildApp();
    const response = await app.request('/account/deletion', {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ confirm: ACCOUNT_DELETION_CONFIRMATION, password: PASSWORD }),
    });
    expect(response.status).toBe(401);
    expect(queries.closeAccount).not.toHaveBeenCalled();
  });

  it('tells the card how this account confirms', async () => {
    vi.mocked(queries.getPasswordHash).mockResolvedValue(null);
    vi.mocked(queries.sessionSignedInWithin).mockResolvedValue(true);
    const app = buildApp();
    const response = await app.request('/account/deletion', { headers: { cookie: sessionCookie() } });
    expect(await response.json()).toEqual({
      confirmWith: 'recent_sign_in',
      recentSignIn: true,
      recentSignInMinutes: RECENT_SIGN_IN_MINUTES,
      allowed: true,
      graceDays: ACCOUNT_DELETION_GRACE_DAYS,
    });
  });
});

describe('signing in during the grace period (D264)', () => {
  function credentials(status: 'closed' | 'disabled') {
    return {
      id: USER.id,
      status,
      password_hash: passwordHash,
      session_version: USER.session_version,
      email: USER.email,
      email_verified: true,
    };
  }

  function login(app: App) {
    return app.request('/auth/login', {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ email: USER.email, password: PASSWORD }),
    });
  }

  beforeEach(() => {
    vi.mocked(queries.createSession).mockResolvedValue({
      id: '5e551000-0000-4000-8000-0000000000aa',
      expires_at: new Date(Math.floor(Date.now() / 1000) * 1000 + 3600 * 1000),
    });
  });

  it('reopens a closed account and says the deletion was cancelled', async () => {
    vi.mocked(queries.getUserCredentialsByEmail).mockResolvedValue(credentials('closed'));
    vi.mocked(queries.reopenClosedAccount).mockResolvedValue(USER);
    const app = buildApp();
    const response = await login(app);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: USER.id, deletionCancelled: true });
    expect(queries.reopenClosedAccount).toHaveBeenCalledWith(USER.id);
    expect(response.headers.get('set-cookie')).toContain(`${SESSION_COOKIE}=`);
    // Mailed, so a sign-in by someone else that undid the deletion is seen.
    await mail.settled();
    expect(mail.sent.map((sent) => [sent.to, sent.subject])).toEqual([[USER.email, 'Your Traders account will not be deleted']]);
  });

  it('refuses a closed account whose date has passed - nothing left to reopen', async () => {
    vi.mocked(queries.getUserCredentialsByEmail).mockResolvedValue(credentials('closed'));
    vi.mocked(queries.reopenClosedAccount).mockResolvedValue(null);
    const app = buildApp();
    const response = await login(app);
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe('account_not_active');
    expect(queries.createSession).not.toHaveBeenCalled();
  });

  it('never reopens an account the admin disabled', async () => {
    vi.mocked(queries.getUserCredentialsByEmail).mockResolvedValue(credentials('disabled'));
    const app = buildApp();
    const response = await login(app);
    expect(response.status).toBe(403);
    expect(queries.reopenClosedAccount).not.toHaveBeenCalled();
    expect(queries.createSession).not.toHaveBeenCalled();
  });

  it('says nothing was cancelled on an ordinary sign-in', async () => {
    vi.mocked(queries.getUserCredentialsByEmail).mockResolvedValue({ ...credentials('closed'), status: 'active' });
    const app = buildApp();
    const response = await login(app);
    expect(await response.json()).toMatchObject({ deletionCancelled: false });
    expect(queries.reopenClosedAccount).not.toHaveBeenCalled();
    await mail.settled();
    expect(mail.sent).toEqual([]);
  });
});

describe('the export (D264)', () => {
  const DOCUMENT = '{"format": "traders-export-1", "holdings": [{"quantity": "0.123456789012345678"}]}';

  function exportData(app: App) {
    return app.request('/account/export', { headers: { cookie: sessionCookie() } });
  }

  it("sends the signed-in user's document as it came, as a file never cached", async () => {
    vi.mocked(queries.exportAccount).mockResolvedValue(DOCUMENT);
    const app = buildApp();
    const response = await exportData(app);
    expect(response.status).toBe(200);
    expect(queries.exportAccount).toHaveBeenCalledWith(USER.id);
    expect(await response.text()).toBe(DOCUMENT);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('content-disposition')).toMatch(/^attachment; filename="traders-export-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('is limited per user (D257)', async () => {
    vi.mocked(queries.exportAccount).mockResolvedValue(DOCUMENT);
    const app = buildApp();
    for (let attempt = 0; attempt < RATE_LIMITS.dataExportPerUser.points; attempt += 1) {
      expect((await exportData(app)).status).toBe(200);
    }
    expect((await exportData(app)).status).toBe(429);
  });

  it('refuses a signed-out request', async () => {
    const app = buildApp();
    expect((await app.request('/account/export')).status).toBe(401);
    expect(queries.exportAccount).not.toHaveBeenCalled();
  });
});

describe('the erase run (D264)', () => {
  function erase(app: App) {
    return app.request('/internal/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': 'internal-test-key' },
      body: JSON.stringify({ kind: 'account_erase', trigger: 'test' }),
    });
  }

  beforeEach(() => {
    vi.mocked(queries.listAccountsDueForErase).mockResolvedValue(['due-1', 'due-2']);
    vi.mocked(queries.listRejectedSignupsOlderThan).mockResolvedValue(['rejected-1']);
    vi.mocked(queries.eraseAccount).mockResolvedValue(true);
  });

  it("is the installation's, asked for at the rhythm the local timer keeps", () => {
    expect(INSTALLATION_KINDS.has('account_erase')).toBe(true);
    expect(INTERVALS_MS.account_erase).toBeDefined();
  });

  it('erases every account past its date, and rejected requests only in automatic signup', async () => {
    vi.mocked(queries.getInstallationSettings).mockResolvedValue({ signup_mode: 'automatic' } as never);
    const app = buildApp();
    const response = await erase(app);
    expect(response.status).toBe(200);
    expect(queries.claimRun).toHaveBeenCalledWith(expect.objectContaining({ kind: 'account_erase', userId: null }));
    expect(queries.listRejectedSignupsOlderThan).toHaveBeenCalledWith(REJECTED_SIGNUP_RETENTION_DAYS);
    expect(vi.mocked(queries.eraseAccount).mock.calls.map(([id]) => id)).toEqual(['due-1', 'due-2', 'rejected-1']);
    expect(queries.finishRun).toHaveBeenCalledWith('run-1', 'ok', { accounts: 2, rejectedSignups: 1, failed: 0 });
  });

  it('keeps rejected requests while the admin decides sign-ups (D156)', async () => {
    vi.mocked(queries.getInstallationSettings).mockResolvedValue({ signup_mode: 'approval' } as never);
    const app = buildApp();
    await erase(app);
    expect(queries.listRejectedSignupsOlderThan).not.toHaveBeenCalled();
    expect(vi.mocked(queries.eraseAccount).mock.calls.map(([id]) => id)).toEqual(['due-1', 'due-2']);
  });

  it('goes on past one that fails, leaves it for the next run, and says the run degraded', async () => {
    vi.mocked(queries.getInstallationSettings).mockResolvedValue({ signup_mode: 'approval' } as never);
    vi.mocked(queries.eraseAccount).mockRejectedValueOnce(new Error('deadlock')).mockResolvedValueOnce(true);
    const app = buildApp();
    await erase(app);
    expect(queries.finishRun).toHaveBeenCalledWith('run-1', 'degraded', { accounts: 1, rejectedSignups: 0, failed: 1 });
  });

  it('does not count an account a sign-in reopened since it was listed', async () => {
    vi.mocked(queries.getInstallationSettings).mockResolvedValue({ signup_mode: 'approval' } as never);
    vi.mocked(queries.eraseAccount).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const app = buildApp();
    await erase(app);
    expect(queries.finishRun).toHaveBeenCalledWith('run-1', 'ok', { accounts: 1, rejectedSignups: 0, failed: 0 });
  });
});
