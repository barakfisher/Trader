/**
 * Per-user settings: the whole-object write, and the database CHECKs restated
 * as errors a client can act on.
 *
 * The database layer is mocked, as in targets.test.ts. That is the point of
 * these tests rather than a shortcut around a Postgres: every rule asserted here
 * is one this process applies *before* any SQL runs, and each exists precisely
 * so the user is told which value is wrong instead of being handed a constraint
 * violation from three layers down.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = {
  id: '00000000-0000-0000-0000-000000000001',
  email: null,
  base_currency: 'USD',
  timezone: 'Asia/Jerusalem',
};

/** The schema's defaults (migration 0006), as `getOrCreateUserSettings` returns them. */
const DEFAULT_SETTINGS_ROW = {
  proposal_severity: 'high',
  proposal_ttl_hours: 24,
  notify_severity: 'high',
  quiet_hours_start: '22:00',
  quiet_hours_end: '07:00',
  muted_until: null as Date | null,
};

vi.mock('../src/db/pool.js', () => ({
  queryOne: vi.fn(async () => ({ ok: 1 })),
  query: vi.fn(async () => []),
  transaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({})),
  initPool: vi.fn(),
  getPool: vi.fn(),
  closePool: vi.fn(),
}));

vi.mock('../src/db/queries.js', () => ({
  getUser: vi.fn(async () => USER),
  listHoldings: vi.fn(async () => []),
  listSnapshots: vi.fn(async () => []),
  recordQuotes: vi.fn(async () => undefined),
  upsertSnapshot: vi.fn(async () => undefined),
  claimRun: vi.fn(async () => ({ claimed: true, runId: 'run-1' })),
  finishRun: vi.fn(async () => undefined),
  listRuns: vi.fn(async () => []),
  insertObservations: vi.fn(async () => ({ created: 0, suppressed: 0, inserted: [] })),
  createProposals: vi.fn(async () => 0),
  listObservations: vi.fn(async () => []),
  listRecentDedupeKeys: vi.fn(async () => []),
  listTargetWeights: vi.fn(async () => []),
  getOrCreateUserSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS_ROW })),
  // Echoes the input back in row form, which is what the real statement's
  // RETURNING does. The route must be seen to render the stored row.
  replaceUserSettings: vi.fn(async (_userId: string, input: Record<string, unknown>) => ({
    proposal_severity: input.proposalSeverity,
    proposal_ttl_hours: input.proposalTtlHours,
    notify_severity: input.notifySeverity,
    quiet_hours_start: input.quietHoursStart,
    quiet_hours_end: input.quietHoursEnd,
    muted_until: input.mutedUntil === null ? null : new Date(input.mutedUntil as string),
  })),
  transaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({})),
}));

const { loadConfig, resetConfigForTests } = await import('../src/config.js');
const { createApp } = await import('../src/http/app.js');
const { MAX_PROPOSAL_TTL_HOURS, MIN_PROPOSAL_TTL_HOURS } = await import(
  '../src/http/routes/settings.js'
);
const { createFakeAi } = await import('./fakeAi.js');
const queries = await import('../src/db/queries.js');

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

const ORIGIN = { origin: 'http://localhost:5173', 'content-type': 'application/json' };

/** A complete, legal settings object. Each test changes exactly one thing in it. */
const VALID_SETTINGS = {
  proposalSeverity: 'notable',
  proposalTtlHours: 48,
  notifySeverity: 'high',
  quietHoursStart: '23:00',
  quietHoursEnd: '06:30',
  mutedUntil: null as string | null,
};

function buildApp() {
  resetConfigForTests();
  return createApp(loadConfig(ENV), createFakeAi());
}

async function loginCookie(app: ReturnType<typeof buildApp>): Promise<string> {
  const response = await app.request('/auth/login', {
    method: 'POST',
    headers: ORIGIN,
    body: JSON.stringify({ passphrase: 'test-passphrase' }),
  });
  const cookie = response.headers.get('set-cookie') as string;
  return cookie.split(';')[0]!;
}

async function putSettings(
  app: ReturnType<typeof buildApp>,
  cookie: string,
  settings: unknown,
): Promise<Response> {
  return app.request('/settings', {
    method: 'PUT',
    headers: { ...ORIGIN, cookie },
    body: JSON.stringify(settings),
  });
}

/** A timestamp comfortably clear of the clock, so no test races the mute check. */
function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

describe('user settings', () => {
  let app: ReturnType<typeof buildApp>;
  let cookie: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = buildApp();
    cookie = await loginCookie(app);
  });

  it('requires a session to read or write settings', async () => {
    expect((await app.request('/settings')).status).toBe(401);
    const write = await app.request('/settings', {
      method: 'PUT',
      headers: ORIGIN,
      body: JSON.stringify(VALID_SETTINGS),
    });
    expect(write.status).toBe(401);
  });

  it('blocks a write from an unknown origin', async () => {
    const response = await app.request('/settings', {
      method: 'PUT',
      headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify(VALID_SETTINGS),
    });
    expect(response.status).toBe(403);
  });

  it('serves the schema defaults to a user who has never saved any', async () => {
    const response = await app.request('/settings', { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      settings: {
        proposalSeverity: DEFAULT_SETTINGS_ROW.proposal_severity,
        proposalTtlHours: DEFAULT_SETTINGS_ROW.proposal_ttl_hours,
        notifySeverity: DEFAULT_SETTINGS_ROW.notify_severity,
        quietHoursStart: DEFAULT_SETTINGS_ROW.quiet_hours_start,
        quietHoursEnd: DEFAULT_SETTINGS_ROW.quiet_hours_end,
        mutedUntil: null,
      },
    });
    expect(queries.getOrCreateUserSettings).toHaveBeenCalledWith(USER.id);
  });

  it('writes every field on a save, so a replace cannot leave a stale one behind', async () => {
    const response = await putSettings(app, cookie, VALID_SETTINGS);
    expect(response.status).toBe(200);
    expect(queries.replaceUserSettings).toHaveBeenCalledWith(USER.id, VALID_SETTINGS);
  });

  it('answers with the stored settings rather than the request it was sent', async () => {
    // The database is the authority on what was written; the client re-renders
    // from the row, so a normalised value is never displayed as typed.
    vi.mocked(queries.replaceUserSettings).mockResolvedValueOnce({
      ...DEFAULT_SETTINGS_ROW,
      proposal_ttl_hours: 12,
    });
    const response = await putSettings(app, cookie, VALID_SETTINGS);
    expect(await response.json()).toMatchObject({ settings: { proposalTtlHours: 12 } });
  });

  it('renders a stored mute as an ISO 8601 UTC timestamp', async () => {
    const mutedUntil = hoursFromNow(2);
    const response = await putSettings(app, cookie, { ...VALID_SETTINGS, mutedUntil });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ settings: { mutedUntil } });
  });

  it('refuses a partial payload, because this endpoint replaces the whole object', async () => {
    const { proposalTtlHours: _omitted, ...partial } = VALID_SETTINGS;
    const response = await putSettings(app, cookie, partial);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_body' });
    expect(queries.replaceUserSettings).not.toHaveBeenCalled();
  });

  it('refuses a TTL longer than a proposal may stay answerable', async () => {
    const response = await putSettings(app, cookie, {
      ...VALID_SETTINGS,
      proposalTtlHours: MAX_PROPOSAL_TTL_HOURS + 1,
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: 'proposal_ttl_out_of_range',
      details: { min: MIN_PROPOSAL_TTL_HOURS, max: MAX_PROPOSAL_TTL_HOURS },
    });
    expect(queries.replaceUserSettings).not.toHaveBeenCalled();
  });

  it('refuses a TTL shorter than the floor', async () => {
    const response = await putSettings(app, cookie, {
      ...VALID_SETTINGS,
      proposalTtlHours: MIN_PROPOSAL_TTL_HOURS - 1,
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: 'proposal_ttl_out_of_range' });
  });

  it('accepts both ends of the permitted TTL range', async () => {
    for (const hours of [MIN_PROPOSAL_TTL_HOURS, MAX_PROPOSAL_TTL_HOURS]) {
      const response = await putSettings(app, cookie, {
        ...VALID_SETTINGS,
        proposalTtlHours: hours,
      });
      expect(response.status).toBe(200);
    }
  });

  it('refuses a fractional TTL instead of letting the column round it', async () => {
    const response = await putSettings(app, cookie, { ...VALID_SETTINGS, proposalTtlHours: 1.5 });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_body' });
  });

  it('refuses quiet hours with only one end set', async () => {
    const response = await putSettings(app, cookie, { ...VALID_SETTINGS, quietHoursEnd: null });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: 'quiet_hours_must_be_a_pair' });
    expect(queries.replaceUserSettings).not.toHaveBeenCalled();
  });

  it('accepts both ends null as "no quiet hours at all"', async () => {
    const response = await putSettings(app, cookie, {
      ...VALID_SETTINGS,
      quietHoursStart: null,
      quietHoursEnd: null,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      settings: { quietHoursStart: null, quietHoursEnd: null },
    });
  });

  it('accepts a window that wraps midnight, which is the ordinary case', async () => {
    const response = await putSettings(app, cookie, {
      ...VALID_SETTINGS,
      quietHoursStart: '22:00',
      quietHoursEnd: '07:00',
    });
    expect(response.status).toBe(200);
  });

  it('refuses a window that starts and ends at the same minute', async () => {
    const response = await putSettings(app, cookie, {
      ...VALID_SETTINGS,
      quietHoursStart: '22:00',
      quietHoursEnd: '22:00',
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: 'quiet_hours_window_is_empty' });
    expect(queries.replaceUserSettings).not.toHaveBeenCalled();
  });

  it('refuses a quiet-hours boundary that is not a 24-hour HH:MM time', async () => {
    for (const start of ['24:00', '7:00', '07:00:00', '22.00', 'evening']) {
      const response = await putSettings(app, cookie, { ...VALID_SETTINGS, quietHoursStart: start });
      expect(response.status).toBe(400);
    }
    expect(queries.replaceUserSettings).not.toHaveBeenCalled();
  });

  it('refuses a severity outside the ladder the engine emits', async () => {
    const response = await putSettings(app, cookie, {
      ...VALID_SETTINGS,
      notifySeverity: 'critical',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_body' });
  });

  it('refuses a mute that has already ended', async () => {
    const response = await putSettings(app, cookie, {
      ...VALID_SETTINGS,
      mutedUntil: hoursFromNow(-1),
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: 'muted_until_in_the_past' });
    expect(queries.replaceUserSettings).not.toHaveBeenCalled();
  });

  it('refuses a mute without a timezone offset, which would be read as a local time', async () => {
    const response = await putSettings(app, cookie, {
      ...VALID_SETTINGS,
      mutedUntil: '2030-01-01T10:00:00',
    });
    expect(response.status).toBe(400);
  });

  it('treats a null mute as clearing one, not as an omission', async () => {
    const response = await putSettings(app, cookie, { ...VALID_SETTINGS, mutedUntil: null });
    expect(response.status).toBe(200);
    expect(queries.replaceUserSettings).toHaveBeenCalledWith(
      USER.id,
      expect.objectContaining({ mutedUntil: null }),
    );
  });
});
