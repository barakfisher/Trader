/**
 * Rate limits (D257): which route spends which limit, on which key, and what a
 * refusal looks like.
 *
 * Counted in memory (`memoryRateLimits`), which is the same package and the
 * same windows as Redis without a server. Each case spends a limit to its last
 * point directly, then makes the request that must be refused - the numbers come
 * from `RATE_LIMITS`, never from here (convention 1).
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Redis } from 'ioredis';

import { ACTIVE_SESSION, TEST_USER_ID, sessionCookie } from './session.js';

const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
const PASSWORD = 'correct horse battery staple';

const userRow = (id: string) => ({
  ...ACTIVE_SESSION,
  id,
  email: 'dana@example.com',
  base_currency: 'USD',
  timezone: 'Asia/Jerusalem',
  role: 'user' as const,
});

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
  recordSignIn: vi.fn(async () => undefined),
  createSession: vi.fn(async () => ({ id: '5e551000-0000-4000-8000-0000000000bb', expires_at: new Date(Date.now() + 3_600_000) })),
  getOrCreateUserSettings: vi.fn(async () => ({ language: 'en' })),
  createSignupRequest: vi.fn(async () => ({ outcome: 'created', userId: OTHER_USER_ID })),
  countPendingSignups: vi.fn(async () => 0),
  getInstallationSettings: vi.fn(async () => ({ default_llm_cap_micro_usd: 10_000_000 })),
  insertAdminAudit: vi.fn(),
}));

vi.mock('../src/telegram/signupApproval.js', () => ({ announceSignupRequest: vi.fn(async () => undefined) }));

const { createApp } = await import('../src/http/app.js');
const { loadConfig, resetConfigForTests } = await import('../src/config.js');
const { hashPassword } = await import('../src/http/password.js');
const {
  RATE_LIMITS,
  RATE_LIMITED,
  addressKey,
  emailKey,
  memoryRateLimits,
  redisRateLimits,
  userKey,
} = await import('../src/http/rateLimits.js');
type RateLimits = ReturnType<typeof memoryRateLimits>;
type RateLimitScope = keyof typeof RATE_LIMITS;
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
  // nginx alone: the client is the last `X-Forwarded-For` entry.
  TRUSTED_PROXY_HOPS: '1',
} as unknown as NodeJS.ProcessEnv;

const ORIGIN = 'http://localhost:5173';
const ADDRESS = '203.0.113.7';
const AGENT = '33333333-3333-4333-8333-333333333333';
const PROPOSAL = '44444444-4444-4444-8444-444444444444';
const TOPIC = '55555555-5555-4555-8555-555555555555';

function buildApp(limits: RateLimits) {
  resetConfigForTests();
  return createApp(loadConfig(ENV), createFakeAi(), undefined, null, limits);
}

type App = ReturnType<typeof buildApp>;

/** Spend `key`'s window in `scope` down to nothing. */
async function spend(limits: RateLimits, scope: RateLimitScope, key: string): Promise<void> {
  for (let point = 0; point < RATE_LIMITS[scope].points; point += 1) {
    expect(await limits.take(scope, key)).toBeNull();
  }
}

/** A refusal is 429 with the code the web translates and when to retry, in the header and the body. */
async function expectRefused(response: Response, scope: RateLimitScope): Promise<void> {
  expect(response.status).toBe(429);
  const body = (await response.json()) as { error: string; details: { retryAfterSeconds: number } };
  expect(body.error).toBe(RATE_LIMITED);
  const retryAfter = Number(response.headers.get('retry-after'));
  expect(retryAfter).toBe(body.details.retryAfterSeconds);
  expect(retryAfter).toBeGreaterThan(0);
  expect(retryAfter).toBeLessThanOrEqual(RATE_LIMITS[scope].durationSeconds);
}

/** Every route that spends a per-user limit, and the limit it spends (D257). */
const PER_USER_ROUTES: { method: string; path: string; scope: RateLimitScope; body?: unknown }[] = [
  { method: 'POST', path: `/agents/${AGENT}/scans`, scope: 'agentScan' },
  { method: 'POST', path: '/assistant/messages', scope: 'assistantQuestion', body: { message: 'How am I doing?' } },
  { method: 'POST', path: `/agents/${AGENT}/instructions-check`, scope: 'instructionsCheck', body: {} },
  { method: 'POST', path: `/proposals/${PROPOSAL}/recheck`, scope: 'proposalRecheck' },
  { method: 'POST', path: '/holdings', scope: 'symbolResolve', body: { symbol: 'AAPL' } },
  { method: 'POST', path: '/imports/preview', scope: 'symbolResolve', body: {} },
  { method: 'POST', path: '/topics/resolve', scope: 'topicResolve', body: { topic: 'chips' } },
  { method: 'POST', path: '/topics', scope: 'topicResolve', body: {} },
  { method: 'PUT', path: `/topics/${TOPIC}`, scope: 'topicResolve', body: {} },
  { method: 'GET', path: '/concepts/search?q=drawdown', scope: 'conceptSearch' },
  { method: 'POST', path: '/portfolio/cash/movements', scope: 'cashMovement', body: { type: 'income', amount: '1' } },
  // Each spends the installation's shared Yahoo budget: per hour, and per minute against a burst.
  { method: 'GET', path: '/instruments/search?q=teva', scope: 'symbolLookup' },
  { method: 'GET', path: '/instruments/search?q=teva', scope: 'symbolLookupBurst' },
  { method: 'GET', path: '/instruments/AAPL/quote', scope: 'symbolLookup' },
  { method: 'GET', path: '/instruments/AAPL/quote', scope: 'symbolLookupBurst' },
];

function asUser(app: App, route: (typeof PER_USER_ROUTES)[number], userId = TEST_USER_ID) {
  return app.request(route.path, {
    method: route.method,
    headers: {
      cookie: sessionCookie(userId),
      ...(route.method === 'GET' ? {} : { origin: ORIGIN, 'content-type': 'application/json' }),
    },
    ...(route.body === undefined ? {} : { body: JSON.stringify(route.body) }),
  });
}

let passwordHash: string;

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
});

let limits: RateLimits;
let app: App;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(queries.getUser).mockImplementation(async (id: string) => userRow(id) as never);
  limits = memoryRateLimits();
  app = buildApp(limits);
});

describe('the routes that cost money or shared quota, per signed-in user', () => {
  it.each(PER_USER_ROUTES)('$method $path spends $scope', async (route) => {
    await spend(limits, route.scope, userKey(TEST_USER_ID));
    await expectRefused(await asUser(app, route), route.scope);
  });

  it.each(PER_USER_ROUTES)('$method $path counts against the user who sent it', async (route) => {
    const before = await limits.take(route.scope, userKey(TEST_USER_ID));
    expect(before).toBeNull();
    // One request, whatever its own answer, uses one point: what is left is
    // everything less the two.
    await asUser(app, route);
    for (let point = 2; point < RATE_LIMITS[route.scope].points; point += 1) {
      expect(await limits.take(route.scope, userKey(TEST_USER_ID))).toBeNull();
    }
    expect(await limits.take(route.scope, userKey(TEST_USER_ID))).not.toBeNull();
  });

  it("one user's spent limit leaves another user's alone", async () => {
    const route = PER_USER_ROUTES[0]!;
    await spend(limits, route.scope, userKey(TEST_USER_ID));
    expect((await asUser(app, route, OTHER_USER_ID)).status).not.toBe(429);
  });

  it('a signed-out request is refused by the session gate, not counted', async () => {
    const route = PER_USER_ROUTES[0]!;
    const response = await app.request(route.path, { method: 'POST', headers: { origin: ORIGIN } });
    expect(response.status).toBe(401);
  });
});

describe('signing in: failures per account and per address', () => {
  function login(email: string, password: string, address = ADDRESS) {
    return app.request('/auth/login', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': address },
      body: JSON.stringify({ email, password }),
    });
  }

  beforeEach(() => {
    vi.mocked(queries.getUserCredentialsByEmail).mockImplementation(async (email: string) =>
      email.trim().toLowerCase() === 'dana@example.com'
        ? ({ id: TEST_USER_ID, password_hash: passwordHash, status: 'active', session_version: 1 } as never)
        : null,
    );
  });

  it('a wrong password counts against the account and the address', async () => {
    expect((await login('dana@example.com', 'wrong')).status).toBe(401);
    for (const [scope, key] of [
      ['loginFailuresPerAccount', emailKey('dana@example.com')],
      ['loginFailuresPerAddress', addressKey(ADDRESS)],
    ] as const) {
      for (let point = 1; point < RATE_LIMITS[scope].points; point += 1) expect(await limits.take(scope, key)).toBeNull();
      expect(await limits.take(scope, key)).not.toBeNull();
    }
  });

  it('an account with its failures spent is refused before the password is checked, even the right one', async () => {
    await spend(limits, 'loginFailuresPerAccount', emailKey('dana@example.com'));
    // From another address too: the account is the key.
    await expectRefused(await login(' Dana@Example.com ', PASSWORD, '198.51.100.1'), 'loginFailuresPerAccount');
    expect(queries.getUserCredentialsByEmail).not.toHaveBeenCalled();
  });

  it('an email with no account is limited the same way, so a refusal names no account', async () => {
    await spend(limits, 'loginFailuresPerAccount', emailKey('nobody@example.com'));
    await expectRefused(await login('nobody@example.com', 'x'), 'loginFailuresPerAccount');
  });

  it('an address with its failures spent is refused for every account', async () => {
    await spend(limits, 'loginFailuresPerAddress', addressKey(ADDRESS));
    await expectRefused(await login('dana@example.com', PASSWORD), 'loginFailuresPerAddress');
    // Another address still signs in.
    expect((await login('dana@example.com', PASSWORD, '198.51.100.1')).status).toBe(200);
  });

  it('the right password clears the account\'s failures and never counts itself', async () => {
    const account = emailKey('dana@example.com');
    for (let point = 1; point < RATE_LIMITS.loginFailuresPerAccount.points; point += 1) {
      expect(await limits.take('loginFailuresPerAccount', account)).toBeNull();
    }
    expect((await login('dana@example.com', PASSWORD)).status).toBe(200);
    // Cleared: the whole window is available again.
    await spend(limits, 'loginFailuresPerAccount', account);
  });

  it('the address comes from the trusted proxy hop, not from what the client prepends', async () => {
    await spend(limits, 'loginFailuresPerAddress', addressKey(ADDRESS));
    // A forged first entry does not move the request to a fresh bucket.
    await expectRefused(await login('dana@example.com', PASSWORD, `198.51.100.9, ${ADDRESS}`), 'loginFailuresPerAddress');
  });
});

describe('asking to join: every request, per address and per email', () => {
  function signup(email: string, address = ADDRESS) {
    return app.request('/auth/signup', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': address },
      body: JSON.stringify({ email, password: PASSWORD, timezone: 'Europe/London', language: 'en' }),
    });
  }

  it('an address that has asked its fill is refused, whatever the email', async () => {
    await spend(limits, 'signupPerAddress', addressKey(ADDRESS));
    await expectRefused(await signup('new@example.com'), 'signupPerAddress');
    expect(queries.createSignupRequest).not.toHaveBeenCalled();
  });

  it('an email that has asked its fill is refused from any address, as typed or normalised', async () => {
    await spend(limits, 'signupPerEmail', emailKey('new@example.com'));
    await expectRefused(await signup(' New@Example.com ', '198.51.100.2'), 'signupPerEmail');
    expect(queries.createSignupRequest).not.toHaveBeenCalled();
  });

  it('each request counts, accepted or not', async () => {
    expect((await signup('new@example.com')).status).toBe(200);
    for (let point = 1; point < RATE_LIMITS.signupPerEmail.points; point += 1) {
      expect(await limits.take('signupPerEmail', emailKey('new@example.com'))).toBeNull();
    }
    expect(await limits.take('signupPerEmail', emailKey('new@example.com'))).not.toBeNull();
  });
});

describe('the Redis store', () => {
  it('counts in this process while Redis cannot be reached: the same limit, neither open nor shut', async () => {
    // Never connected (lazyConnect): no network, and the client is not ready.
    const client = new Redis('redis://127.0.0.1:6379/0', { lazyConnect: true, enableOfflineQueue: false });
    const fallback = redisRateLimits(client);
    await spend(fallback, 'agentScan', userKey(TEST_USER_ID));
    expect(await fallback.take('agentScan', userKey(TEST_USER_ID))).not.toBeNull();
    expect(client.status).toBe('wait');
    client.disconnect();
  });
});
