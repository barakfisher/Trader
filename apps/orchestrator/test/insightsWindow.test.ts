/**
 * The Insights window (decision 133): today in the user's timezone, then back
 * one day at a time, seven days in all - and the API that serves it, refuses a
 * day outside it, and moves "seen" only to the moment the page counted.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTIVE_SESSION, sessionCookie } from './session.js';

const USER = {
  ...ACTIVE_SESSION,
  id: '00000000-0000-0000-0000-000000000001',
  email: null,
  base_currency: 'USD',
  timezone: 'Asia/Jerusalem',
};
const AGENT = '90000000-0000-0000-0000-000000000001';

vi.mock('../src/db/pool.js', () => ({
  queryOne: vi.fn(async () => ({ ok: 1 })),
  query: vi.fn(async () => []),
  transaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({})),
  initPool: vi.fn(),
  getPool: vi.fn(),
  closePool: vi.fn(),
}));

const queries = vi.hoisted(() => ({
  primaryAgentId: vi.fn(async () => '90000000-0000-0000-0000-000000000001'),
  listObservations: vi.fn(async (): Promise<unknown[]> => []),
  countObservations: vi.fn(async () => 0),
  countObservationsByDay: vi.fn(async (): Promise<unknown[]> => []),
  getInsightsSeenAt: vi.fn(async (): Promise<Date | null> => null),
  markInsightsSeen: vi.fn(async (_userId: string, upTo: Date): Promise<Date | null> => upTo),
}));

vi.mock('../src/db/queries.js', () => ({
  getSessionUser: vi.fn(async (userId: string) => (await import('./session.js')).mockedSessionUser(userId)),
  getUser: vi.fn(async () => USER), ...queries }));

const { INSIGHTS_DAYS, isWindowDay, shiftDay, windowDays } = await import(
  '../src/services/insightsWindow.js'
);
const { loadConfig, resetConfigForTests } = await import('../src/config.js');
const { createApp } = await import('../src/http/app.js');

describe('windowDays', () => {
  it('is today and the days before it, seven in all, newest first', () => {
    const days = windowDays('Asia/Jerusalem', new Date('2026-10-11T09:00:00Z'));
    expect(days).toHaveLength(INSIGHTS_DAYS);
    expect(days[0]).toBe('2026-10-11');
    expect(days.at(-1)).toBe(shiftDay('2026-10-11', -(INSIGHTS_DAYS - 1)));
  });

  it("starts at the user's today, not the server's", () => {
    // 22:30 UTC on the 10th is already the 11th in Jerusalem.
    const late = new Date('2026-10-10T22:30:00Z');
    expect(windowDays('Asia/Jerusalem', late)[0]).toBe('2026-10-11');
    expect(windowDays('UTC', late)[0]).toBe('2026-10-10');
  });

  it('refuses the day before the window, a future day, and a malformed one', () => {
    const now = new Date('2026-10-11T09:00:00Z');
    expect(isWindowDay(shiftDay('2026-10-11', -(INSIGHTS_DAYS - 1)), 'Asia/Jerusalem', now)).toBe(true);
    expect(isWindowDay(shiftDay('2026-10-11', -INSIGHTS_DAYS), 'Asia/Jerusalem', now)).toBe(false);
    expect(isWindowDay('2026-10-12', 'Asia/Jerusalem', now)).toBe(false);
    expect(isWindowDay('11/10/2026', 'Asia/Jerusalem', now)).toBe(false);
  });

  it('crosses a month end', () => {
    expect(shiftDay('2026-10-01', -1)).toBe('2026-09-30');
  });
});

describe('the Insights window API', () => {
  const ENV = {
    APP_ENV: 'test',
    LOG_LEVEL: 'error',
      SESSION_SECRET: 'test-session-secret-value',
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
    AI_SERVICE_URL: 'http://ai-service:8000',
    INTERNAL_API_KEY: 'internal-test-key',
    ALLOWED_ORIGINS: 'http://localhost:5173',
  } as unknown as NodeJS.ProcessEnv;

  let app: ReturnType<typeof createApp>;
  let cookie: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    resetConfigForTests();
    app = createApp(loadConfig(ENV), {} as never);
    cookie = sessionCookie();
  });

  it('serves all seven days, empty ones included, with their unread counts', async () => {
    const today = windowDays(USER.timezone)[0]!;
    const seenAt = new Date('2026-10-09T12:00:00Z');
    queries.getInsightsSeenAt.mockResolvedValueOnce(seenAt);
    queries.countObservationsByDay.mockResolvedValueOnce([{ day: today, count: 3, unread: 2 }]);

    const response = await app.request('/observations/days', { headers: { cookie } });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.seenAt).toBe(seenAt.toISOString());
    expect(body.days).toHaveLength(INSIGHTS_DAYS);
    expect(body.days[0]).toEqual({ day: today, count: 3, unread: 2 });
    expect(body.days.slice(1).every((day: { count: number }) => day.count === 0)).toBe(true);
    // Counted from the window's oldest day, in the user's timezone.
    expect(queries.countObservationsByDay).toHaveBeenCalledWith(
      USER.id,
      AGENT,
      USER.timezone,
      body.days.at(-1).day,
      seenAt,
    );
  });

  it("filters the feed to one day in the user's timezone, and refuses a day outside the window", async () => {
    const [, yesterday] = windowDays(USER.timezone);
    const ok = await app.request(`/observations?day=${yesterday}`, { headers: { cookie } });
    expect(ok.status).toBe(200);
    expect(queries.listObservations).toHaveBeenCalledWith(
      USER.id,
      AGENT,
      51,
      expect.objectContaining({ day: { date: yesterday, timezone: USER.timezone } }),
      null,
    );

    const tooOld = shiftDay(windowDays(USER.timezone).at(-1)!, -1);
    const refused = await app.request(`/observations?day=${tooOld}`, { headers: { cookie } });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toBe('invalid_day');
  });

  it('marks seen up to the moment the page counted, and refuses a body without one', async () => {
    const upTo = '2026-10-11T09:00:00.000Z';
    const response = await app.request('/observations/seen', {
      method: 'POST',
      headers: { cookie, origin: 'http://localhost:5173', 'content-type': 'application/json' },
      body: JSON.stringify({ upTo }),
    });
    expect(response.status).toBe(200);
    expect(queries.markInsightsSeen).toHaveBeenCalledWith(USER.id, new Date(upTo));

    const bad = await app.request('/observations/seen', {
      method: 'POST',
      headers: { cookie, origin: 'http://localhost:5173', 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(bad.status).toBe(400);
  });
});
