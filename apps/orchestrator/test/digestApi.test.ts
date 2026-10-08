/**
 * `GET /notifications/digest`: the daily digest as the Insights page shows it
 * (FR-13) - what the next one will carry, and what the last one delivered -
 * and `POST /notifications/digest/seen`, which ends its dashboard banner (UX4).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = {
  id: '00000000-0000-0000-0000-000000000001',
  email: null,
  base_currency: 'USD',
  timezone: 'Asia/Jerusalem',
};

vi.mock('../src/db/pool.js', () => ({
  queryOne: vi.fn(async () => ({ ok: 1 })),
  query: vi.fn(async () => []),
  transaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({})),
  initPool: vi.fn(),
  getPool: vi.fn(),
  closePool: vi.fn(),
}));

const queries = vi.hoisted(() => ({
  listPendingDigestEntries: vi.fn(async (): Promise<unknown[]> => []),
  listLastDigestEntries: vi.fn(async (): Promise<unknown[]> => []),
  listNotifications: vi.fn(async (): Promise<unknown[]> => []),
  getDigestSeenAt: vi.fn(async (): Promise<Date | null> => null),
  markDigestSeen: vi.fn(async (_userId: string, sentAt: Date): Promise<Date | null> => sentAt),
}));

vi.mock('../src/db/queries.js', () => ({ getUser: vi.fn(async () => USER), ...queries }));

const { loadConfig, resetConfigForTests } = await import('../src/config.js');
const { createApp } = await import('../src/http/app.js');

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

function row(overrides: Record<string, unknown> = {}) {
  return {
    notification_id: 'n-1',
    reason: 'quiet_hours',
    status: 'pending',
    sent_at: null,
    created_at: new Date('2026-09-30T00:51:41Z'),
    observation_id: 'o-1',
    headline: 'SMR is -30.6% from its 30-day high',
    severity: 'high',
    subject_ref: 'instrument:SMR',
    ...overrides,
  };
}

let app: ReturnType<typeof createApp>;
let cookie: string;

beforeEach(async () => {
  vi.clearAllMocks();
  resetConfigForTests();
  app = createApp(loadConfig(ENV), {} as never);
  const response = await app.request('/auth/login', {
    method: 'POST',
    headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' },
    body: JSON.stringify({ passphrase: 'test-passphrase' }),
  });
  cookie = (response.headers.get('set-cookie') as string).split(';')[0]!;
});

const get = () => app.request('/notifications/digest', { headers: { cookie } });

describe('GET /notifications/digest', () => {
  it('says what the next digest holds, with why each was held back', async () => {
    const localized = { he: { headline: 'מחיר \u2066SMR\u2069 נמצא \u2066-30.6%\u2069 מהשיא של \u206630\u2069 יום', explanation: '' } };
    queries.listPendingDigestEntries.mockResolvedValueOnce([row({ localized })]);

    const body = await (await get()).json();

    expect(queries.listPendingDigestEntries).toHaveBeenCalledWith(USER.id);
    expect(body.next.entries).toEqual([
      {
        observationId: 'o-1',
        headline: 'SMR is -30.6% from its 30-day high',
        localized,
        severity: 'high',
        subjectRef: 'instrument:SMR',
        reason: 'quiet_hours',
        createdAt: '2026-09-30T00:51:41.000Z',
      },
    ]);
    expect(body.last).toBeNull();
  });

  it('dates the last digest by when it was delivered', async () => {
    queries.listLastDigestEntries.mockResolvedValueOnce([
      row({ status: 'sent', sent_at: new Date('2026-09-30T06:45:29.300Z'), reason: 'below_floor' }),
      row({ notification_id: 'n-2', status: 'sent', sent_at: new Date('2026-09-30T06:45:29.305Z') }),
    ]);

    const body = await (await get()).json();

    expect(body.last.sentAt).toBe('2026-09-30T06:45:29.305Z');
    expect(body.last.entries).toHaveLength(2);
  });

  it('keeps a narration notice, which has no finding behind it', async () => {
    queries.listPendingDigestEntries.mockResolvedValueOnce([
      row({ observation_id: null, headline: null, severity: null, subject_ref: null, reason: 'below_floor' }),
    ]);
    const body = await (await get()).json();
    expect(body.next.entries[0]).toMatchObject({ observationId: null, headline: null });
  });

  it('requires a session', async () => {
    expect((await app.request('/notifications/digest')).status).toBe(401);
  });
});

describe('whether the last digest was seen (UX4)', () => {
  const SENT = '2026-09-30T06:45:29.305Z';
  const delivered = () =>
    queries.listLastDigestEntries.mockResolvedValueOnce([row({ status: 'sent', sent_at: new Date(SENT) })]);

  it('is unseen until the user has seen that digest', async () => {
    delivered();
    queries.getDigestSeenAt.mockResolvedValueOnce(null);
    expect((await (await get()).json()).last.seen).toBe(false);
  });

  it('is unseen when only an earlier digest was seen', async () => {
    delivered();
    queries.getDigestSeenAt.mockResolvedValueOnce(new Date('2026-09-29T06:45:00Z'));
    expect((await (await get()).json()).last.seen).toBe(false);
  });

  it('is seen once that digest was', async () => {
    delivered();
    queries.getDigestSeenAt.mockResolvedValueOnce(new Date(SENT));
    expect((await (await get()).json()).last.seen).toBe(true);
  });

  const mark = (body: unknown, headers: Record<string, string> = { cookie }) =>
    app.request('/notifications/digest/seen', {
      method: 'POST',
      headers: { origin: 'http://localhost:5173', 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  it('records the digest the client showed, for this user', async () => {
    const response = await mark({ sentAt: SENT });
    expect(response.status).toBe(200);
    expect(queries.markDigestSeen).toHaveBeenCalledWith(USER.id, new Date(SENT));
    expect(await response.json()).toEqual({ seenAt: SENT });
  });

  it('refuses a body that names no time', async () => {
    expect((await mark({ sentAt: 'yesterday' })).status).toBe(400);
    expect((await mark({})).status).toBe(400);
    expect(queries.markDigestSeen).not.toHaveBeenCalled();
  });

  it('requires a session', async () => {
    expect((await mark({ sentAt: SENT }, {})).status).toBe(401);
  });
});
