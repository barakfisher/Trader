/**
 * Sign-in through Google and GitHub (D262, D263, D314): the start, the
 * callback's four answers, and linking in Settings. The provider is a fake -
 * no network - and the database is mocked; the state cookie's signing is real.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ACTIVE_SESSION, TEST_USER_ID, sessionCookie } from './session.js';

const ACCOUNT = '33333333-3333-4333-8333-333333333333';

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
  getOrCreateUserSettings: vi.fn(async () => ({ language: 'en' })),
  getInstallationSettings: vi.fn(async () => ({ default_llm_cap_micro_usd: 0 })),
  getIdentityUser: vi.fn(async () => null),
  getAccountByEmail: vi.fn(async () => null),
  linkIdentity: vi.fn(async () => 'linked'),
  claimUnverifiedRequest: vi.fn(),
  createOAuthAccount: vi.fn(),
  listIdentities: vi.fn(async () => []),
  unlinkIdentity: vi.fn(),
  recordSignIn: vi.fn(async () => undefined),
  reopenClosedAccount: vi.fn(async () => null),
  createSession: vi.fn(async () => ({ id: '5e551000-0000-4000-8000-0000000000ee', expires_at: new Date(Date.now() + 3_600_000) })),
}));

vi.mock('../src/telegram/signupApproval.js', () => ({ announceSignupRequest: vi.fn(async () => undefined) }));

const { createApp } = await import('../src/http/app.js');
const { loadConfig, resetConfigForTests } = await import('../src/config.js');
const queries = await import('../src/db/queries.js');
const { createFakeAi } = await import('./fakeAi.js');
const { memoryRateLimits } = await import('../src/http/rateLimits.js');
const { RecordingEmailSender } = await import('./recordingEmailSender.js');
const { OAUTH_STATE_COOKIE, decodeOAuthState } = await import('../src/oauth/stateCookie.js');
const { oauthRedirectUri } = await import('../src/http/routes/oauth.js');
const { announceSignupRequest } = await import('../src/telegram/signupApproval.js');

const ORIGIN = 'http://localhost:5173';
const ENV = {
  APP_ENV: 'test',
  LOG_LEVEL: 'error',
  SESSION_SECRET: 'test-session-secret-value',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  AI_SERVICE_URL: 'http://ai-service:8000',
  INTERNAL_API_KEY: 'internal-test-key',
  ALLOWED_ORIGINS: ORIGIN,
} as unknown as NodeJS.ProcessEnv;

/** What the fake provider says signed in; each test sets it. */
let who = { subject: 'google-sub-1', email: 'noa@example.com' as string | null, emailVerified: true, authoritative: true };
const identify = vi.fn(async () => who);
const fakeGoogle = {
  name: 'google' as const,
  authorizationUrl: ({ state, redirectUri }: { state: string; redirectUri: string }) =>
    new URL(`https://accounts.example/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`),
  identify,
};

let mail = new RecordingEmailSender();
function buildApp() {
  resetConfigForTests();
  mail = new RecordingEmailSender();
  return createApp(loadConfig(ENV), createFakeAi(), undefined, null, memoryRateLimits(), mail, new Map([['google', fakeGoogle]]));
}
type App = ReturnType<typeof buildApp>;

/** Start a sign-in and come back with the provider's code; returns the callback's response. */
async function roundTrip(app: App, { intent = 'signin', cookie = '' } = {}) {
  const start = await app.request(`/auth/oauth/google/start?origin=${encodeURIComponent(ORIGIN)}&intent=${intent}&timezone=Europe/London&language=he`, {
    headers: cookie ? { cookie } : {},
  });
  expect(start.status).toBe(302);
  const stateCookie = start.headers.get('set-cookie')!.split(';')[0]!;
  const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
  return app.request(`/auth/oauth/google/callback?code=the-code&state=${state}`, {
    headers: { cookie: [stateCookie, cookie].filter(Boolean).join('; ') },
  });
}

const landedOn = (response: Response) => new URL(response.headers.get('location')!);

beforeEach(() => {
  vi.clearAllMocks();
  who = { subject: 'google-sub-1', email: 'noa@example.com', emailVerified: true, authoritative: true };
  vi.mocked(queries.getIdentityUser).mockResolvedValue(null);
  vi.mocked(queries.getAccountByEmail).mockResolvedValue(null);
  vi.mocked(queries.linkIdentity).mockResolvedValue('linked');
});

describe('starting a sign-in (D262)', () => {
  it('offers only the providers with an app configured', async () => {
    expect(await (await buildApp().request('/auth/oauth/providers')).json()).toEqual({ providers: ['google'] });
  });

  it('sends the browser to the provider with a signed, short-lived state cookie and our callback', async () => {
    const response = await buildApp().request(`/auth/oauth/google/start?origin=${encodeURIComponent(ORIGIN)}&timezone=Europe/London&language=he`);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!);
    expect(location.searchParams.get('redirect_uri')).toBe(oauthRedirectUri(ORIGIN, 'google'));
    const cookie = response.headers.get('set-cookie')!;
    expect(cookie).toContain(`${OAUTH_STATE_COOKIE}=`);
    expect(cookie).toContain('HttpOnly');
    const saved = decodeOAuthState(cookie.split(';')[0]!.split('=')[1], 'test-session-secret-value')!;
    expect(saved).toMatchObject({ provider: 'google', origin: ORIGIN, intent: 'signin', timezone: 'Europe/London', language: 'he' });
    expect(location.searchParams.get('state')).toBe(saved.state);
  });

  it('refuses an origin this installation does not serve, so nobody chooses where the browser returns', async () => {
    const response = await buildApp().request('/auth/oauth/google/start?origin=https%3A%2F%2Fevil.example');
    expect(response.status).toBe(400);
  });

  it('answers 404 for a provider with no app here', async () => {
    expect((await buildApp().request(`/auth/oauth/github/start?origin=${encodeURIComponent(ORIGIN)}`)).status).toBe(404);
  });

  it('needs a session to start a link from Settings', async () => {
    expect((await buildApp().request(`/auth/oauth/google/start?origin=${encodeURIComponent(ORIGIN)}&intent=link`)).status).toBe(401);
  });
});

describe('coming back from the provider (D262, D263, D314)', () => {
  it('refuses a callback this browser did not start, signing nobody in', async () => {
    const app = buildApp();
    const forged = await app.request('/auth/oauth/google/callback?code=the-code&state=made-up');
    expect(forged.headers.get('location')).toBe('/?oauth=failed');
    expect(identify).not.toHaveBeenCalled();

    // A real cookie with another state: a callback from someone else's sign-in.
    const start = await app.request(`/auth/oauth/google/start?origin=${encodeURIComponent(ORIGIN)}`);
    const swapped = await app.request('/auth/oauth/google/callback?code=the-code&state=someone-elses', {
      headers: { cookie: start.headers.get('set-cookie')!.split(';')[0]! },
    });
    expect(landedOn(swapped).searchParams.get('oauth')).toBe('failed');
    expect(identify).not.toHaveBeenCalled();
  });

  it('signs a linked identity in to its active account', async () => {
    vi.mocked(queries.getIdentityUser).mockResolvedValue({ user_id: ACCOUNT, status: 'active' });
    vi.mocked(queries.getUser).mockResolvedValue({ ...ACTIVE_SESSION, id: ACCOUNT } as never);
    const response = await roundTrip(buildApp());
    expect(landedOn(response).searchParams.get('oauth')).toBe('signed_in');
    expect(response.headers.get('set-cookie')).toContain('traders_session=');
  });

  it('reopens a closed account a linked identity signs in to, and says the deletion was cancelled (D264)', async () => {
    vi.mocked(queries.getIdentityUser).mockResolvedValue({ user_id: ACCOUNT, status: 'closed' });
    vi.mocked(queries.getUser).mockResolvedValue({ ...ACTIVE_SESSION, id: ACCOUNT, status: 'closed' } as never);
    vi.mocked(queries.reopenClosedAccount).mockResolvedValue({ ...ACTIVE_SESSION, id: ACCOUNT } as never);
    const response = await roundTrip(buildApp());
    expect(queries.reopenClosedAccount).toHaveBeenCalledWith(ACCOUNT, ACTIVE_SESSION.session_version);
    expect(landedOn(response).searchParams.get('oauth')).toBe('restored');
    expect(response.headers.get('set-cookie')).toContain('traders_session=');
  });

  it('never reopens an account the admin disabled, whatever identity signs in (D264)', async () => {
    vi.mocked(queries.getIdentityUser).mockResolvedValue({ user_id: ACCOUNT, status: 'disabled' });
    vi.mocked(queries.getUser).mockResolvedValue({ ...ACTIVE_SESSION, id: ACCOUNT, status: 'disabled' } as never);
    const response = await roundTrip(buildApp());
    expect(queries.reopenClosedAccount).not.toHaveBeenCalled();
    expect(landedOn(response).searchParams.get('oauth')).toBe('not_active');
    expect(queries.createSession).not.toHaveBeenCalled();
  });

  it("links an active account at the address the provider vouches for, mails it, and signs in", async () => {
    vi.mocked(queries.getAccountByEmail).mockResolvedValue({ id: ACCOUNT, status: 'active', role: 'user', email_verified: true });
    vi.mocked(queries.getUser).mockResolvedValue({ ...ACTIVE_SESSION, id: ACCOUNT, email: 'noa@example.com' } as never);
    const response = await roundTrip(buildApp());
    expect(queries.linkIdentity).toHaveBeenCalledWith({ userId: ACCOUNT, provider: 'google', subject: 'google-sub-1', email: 'noa@example.com' });
    expect(landedOn(response).searchParams.get('oauth')).toBe('signed_in');
    await mail.settled();
    expect(mail.sent.map((sent) => sent.subject)).toEqual(['Google was linked to your Traders account']);
  });

  it('links nothing and opens nothing for an address the provider does not vouch for', async () => {
    who = { subject: 'google-sub-2', email: 'noa@example.com', emailVerified: false, authoritative: false };
    vi.mocked(queries.getAccountByEmail).mockResolvedValue({ id: ACCOUNT, status: 'active', role: 'user', email_verified: true });
    const response = await roundTrip(buildApp());
    expect(landedOn(response).searchParams.get('oauth')).toBe('unverified_email');
    expect(queries.linkIdentity).not.toHaveBeenCalled();
    expect(queries.createOAuthAccount).not.toHaveBeenCalled();
  });

  it("links nothing automatically when the provider is not the mailbox's authority now (D315)", async () => {
    who = { subject: 'google-sub-3', email: 'noa@company.example', emailVerified: true, authoritative: false };
    vi.mocked(queries.getAccountByEmail).mockResolvedValue({ id: ACCOUNT, status: 'active', role: 'user', email_verified: true });
    expect(landedOn(await roundTrip(buildApp())).searchParams.get('oauth')).toBe('link_from_settings');
    expect(queries.linkIdentity).not.toHaveBeenCalled();
    expect(queries.claimUnverifiedRequest).not.toHaveBeenCalled();
  });

  it('links nothing automatically where no mail could announce it (D263, D315)', async () => {
    vi.mocked(queries.getAccountByEmail).mockResolvedValue({ id: ACCOUNT, status: 'active', role: 'user', email_verified: true });
    resetConfigForTests();
    const noMail = createApp(loadConfig(ENV), createFakeAi(), undefined, null, memoryRateLimits(), null, new Map([['google', fakeGoogle]]));
    expect(landedOn(await roundTrip(noMail)).searchParams.get('oauth')).toBe('link_from_settings');
    expect(queries.linkIdentity).not.toHaveBeenCalled();
  });

  it('never links the admin automatically: the admin links from Settings (D314)', async () => {
    vi.mocked(queries.getAccountByEmail).mockResolvedValue({ id: ACCOUNT, status: 'active', role: 'admin', email_verified: true });
    const response = await roundTrip(buildApp());
    expect(landedOn(response).searchParams.get('oauth')).toBe('admin_link_from_settings');
    expect(queries.linkIdentity).not.toHaveBeenCalled();
  });

  it("claims an unverified request at that address, so its first password is gone (D314)", async () => {
    vi.mocked(queries.getAccountByEmail).mockResolvedValue({ id: ACCOUNT, status: 'pending', role: 'user', email_verified: false });
    vi.mocked(queries.claimUnverifiedRequest).mockResolvedValue('awaiting_approval');
    const response = await roundTrip(buildApp());
    expect(queries.claimUnverifiedRequest).toHaveBeenCalledWith(
      { userId: ACCOUNT, provider: 'google', subject: 'google-sub-1', email: 'noa@example.com' },
      expect.anything(),
    );
    expect(landedOn(response).searchParams.get('oauth')).toBe('pending');
    expect(announceSignupRequest).toHaveBeenCalledWith(expect.anything(), ACCOUNT);
  });

  it('refuses a disabled account', async () => {
    vi.mocked(queries.getAccountByEmail).mockResolvedValue({ id: ACCOUNT, status: 'disabled', role: 'user', email_verified: true });
    expect(landedOn(await roundTrip(buildApp())).searchParams.get('oauth')).toBe('not_active');
    expect(queries.linkIdentity).not.toHaveBeenCalled();
  });

  it("opens a new account in the browser's zone and language, by the installation's rules", async () => {
    vi.mocked(queries.createOAuthAccount).mockResolvedValue({ outcome: 'activated', userId: ACCOUNT });
    vi.mocked(queries.getUser).mockResolvedValue({ ...ACTIVE_SESSION, id: ACCOUNT } as never);
    const response = await roundTrip(buildApp());
    expect(queries.createOAuthAccount).toHaveBeenCalledWith(
      { email: 'noa@example.com', provider: 'google', subject: 'google-sub-1', timezone: 'Europe/London', language: 'he' },
      expect.anything(),
    );
    expect(landedOn(response).searchParams.get('oauth')).toBe('signed_in');
  });

  it('says sign-up is closed when the rules leave no place', async () => {
    vi.mocked(queries.createOAuthAccount).mockResolvedValue({ outcome: 'signup_full' });
    expect(landedOn(await roundTrip(buildApp())).searchParams.get('oauth')).toBe('closed');
  });

  it('holds only *automatic* on a production installation whose legal text is pending (D265, D344)', async () => {
    resetConfigForTests();
    const held = createApp(
      loadConfig({ ...ENV, APP_ENV: 'production', ALLOWED_ORIGINS: 'https://traders.example,http://localhost:5173' } as NodeJS.ProcessEnv),
      createFakeAi(),
      undefined,
      null,
      memoryRateLimits(),
      mail,
      new Map([['google', fakeGoogle]]),
      null,
    );
    const heldRules = expect.objectContaining({ automaticHeld: true });
    // A stored *automatic*: the database admits nobody, so both doors answer closed.
    vi.mocked(queries.createOAuthAccount).mockResolvedValue({ outcome: 'signup_full' });
    expect(landedOn(await roundTrip(held)).searchParams.get('oauth')).toBe('closed');
    expect(queries.createOAuthAccount).toHaveBeenCalledWith(expect.anything(), heldRules);
    vi.mocked(queries.getAccountByEmail).mockResolvedValue({ id: ACCOUNT, status: 'pending', role: 'user', email_verified: false });
    vi.mocked(queries.claimUnverifiedRequest).mockResolvedValue('signup_full');
    expect(landedOn(await roundTrip(held)).searchParams.get('oauth')).toBe('closed');
    expect(queries.claimUnverifiedRequest).toHaveBeenCalledWith(expect.anything(), heldRules);
    // *Approval*: the request waits for the admin, as anywhere else.
    vi.mocked(queries.claimUnverifiedRequest).mockResolvedValue('awaiting_approval');
    expect(landedOn(await roundTrip(held)).searchParams.get('oauth')).toBe('pending');
    vi.mocked(queries.getAccountByEmail).mockResolvedValue(null);
    vi.mocked(queries.createOAuthAccount).mockResolvedValue({ outcome: 'awaiting_approval', userId: ACCOUNT });
    expect(landedOn(await roundTrip(held)).searchParams.get('oauth')).toBe('pending');
  });

  it('holds nothing on a development installation (D256)', async () => {
    vi.mocked(queries.createOAuthAccount).mockResolvedValue({ outcome: 'signup_full' });
    await roundTrip(buildApp());
    expect(queries.createOAuthAccount).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ automaticHeld: false }));
  });

  it('says it failed, and signs nobody in, when the provider refuses the code', async () => {
    identify.mockRejectedValueOnce(new Error('invalid_grant'));
    const response = await roundTrip(buildApp());
    expect(landedOn(response).searchParams.get('oauth')).toBe('failed');
    expect(response.headers.get('set-cookie')).not.toContain('traders_session=');
  });
});

describe('linking from Settings (D263)', () => {
  beforeEach(() => {
    vi.mocked(queries.getUser).mockResolvedValue({ ...ACTIVE_SESSION, id: TEST_USER_ID, email: 'me@example.com' } as never);
  });

  it('links to the signed-in account and lands back on Settings', async () => {
    const response = await roundTrip(buildApp(), { intent: 'link', cookie: sessionCookie() });
    expect(queries.linkIdentity).toHaveBeenCalledWith({ userId: TEST_USER_ID, provider: 'google', subject: 'google-sub-1', email: 'noa@example.com' });
    expect(landedOn(response).pathname).toBe('/settings');
    expect(landedOn(response).searchParams.get('oauth')).toBe('linked');
  });

  it('refuses an identity already linked to another account', async () => {
    vi.mocked(queries.getIdentityUser).mockResolvedValue({ user_id: ACCOUNT, status: 'active' });
    const response = await roundTrip(buildApp(), { intent: 'link', cookie: sessionCookie() });
    expect(landedOn(response).searchParams.get('oauth')).toBe('taken');
    expect(queries.linkIdentity).not.toHaveBeenCalled();
  });

  it("refuses a one-time password's session: it can change the password and nothing else (D162, D315)", async () => {
    vi.mocked(queries.getUser).mockResolvedValue({ ...ACTIVE_SESSION, id: TEST_USER_ID, password_must_change: true } as never);
    const app = buildApp();
    const start = await app.request(`/auth/oauth/google/start?origin=${encodeURIComponent(ORIGIN)}&intent=link`, {
      headers: { cookie: sessionCookie() },
    });
    expect(start.status).toBe(403);
    const unlink = await app.request('/auth/identities/google', { method: 'DELETE', headers: { cookie: sessionCookie(), origin: ORIGIN } });
    expect(unlink.status).toBe(403);
    expect(queries.unlinkIdentity).not.toHaveBeenCalled();
  });

  it('lists the linked providers and what this installation offers', async () => {
    vi.mocked(queries.listIdentities).mockResolvedValue([{ provider: 'google', email: 'noa@example.com', created_at: new Date('2026-10-26T10:00:00Z') }]);
    const response = await buildApp().request('/auth/identities', { headers: { cookie: sessionCookie() } });
    expect(await response.json()).toEqual({
      identities: [{ provider: 'google', email: 'noa@example.com', linkedAt: '2026-10-26T10:00:00.000Z' }],
      available: ['google'],
    });
  });

  it("refuses to unlink the account's only way to sign in", async () => {
    vi.mocked(queries.unlinkIdentity).mockResolvedValue('last_method');
    const response = await buildApp().request('/auth/identities/google', {
      method: 'DELETE',
      headers: { cookie: sessionCookie(), origin: ORIGIN },
    });
    expect(response.status).toBe(409);
  });
});
