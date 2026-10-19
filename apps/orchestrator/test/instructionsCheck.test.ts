/**
 * The contradiction check's orchestrator side (D176-D178): the fingerprint, when a
 * stored result still applies, and the route that stores it only for the text it
 * judged. The database layer is mocked; the SQL runs in queries.postgres.test.ts.
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
const AGENT = '90000000-0000-0000-0000-0000000000a1';
const PRIMARY = '90000000-0000-0000-0000-000000000001';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT,
    is_primary: false,
    persona: 'Trade momentum daily.',
    risk_level: null,
    horizon: 'long',
    thesis_style: null,
    max_position_bps: 1000,
    cash_buffer_bps: null,
    max_holdings: null,
    allow_etfs: true,
    market_caps: [],
    sectors: [],
    industries: [],
    etf_categories: [],
    blocked_symbols: [],
    instructions_check: null,
    ...overrides,
  };
}

let stored = row();

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
  getAgent: vi.fn(async (_userId: string, agentId: string) =>
    agentId === PRIMARY ? row({ id: PRIMARY, is_primary: true, persona: null }) : stored,
  ),
  saveInstructionsCheck: vi.fn(async () => undefined),
  dismissInstructionsCheck: vi.fn(async () => undefined),
}));

const { loadConfig, resetConfigForTests } = await import('../src/config.js');
const { createApp } = await import('../src/http/app.js');
const { currentConflicts, instructionsFingerprint } = await import('../src/services/instructionsCheck.js');
const { createFakeAi } = await import('./fakeAi.js');
const queries = await import('../src/db/queries.js');

const ENV = {
  APP_ENV: 'test',
  LOG_LEVEL: 'error',
  SESSION_SECRET: 'test-session-secret-value',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  AI_SERVICE_URL: 'http://ai-service:8000',
  INTERNAL_API_KEY: 'internal-test-key',
  ALLOWED_ORIGINS: 'http://localhost:5173',
} as unknown as NodeJS.ProcessEnv;
const ORIGIN = { origin: 'http://localhost:5173', 'content-type': 'application/json' };
const CONFLICT = { setting: 'horizon' as const, quote: 'Trade momentum daily.' };

describe('the fingerprint and what it shows (D178)', () => {
  it('changes with the instructions or any setting, and not with surrounding spaces', () => {
    const base = instructionsFingerprint(row() as never);
    expect(instructionsFingerprint(row({ persona: '  Trade momentum daily.\n' }) as never)).toBe(base);
    expect(instructionsFingerprint(row({ persona: 'Trade momentum weekly.' }) as never)).not.toBe(base);
    expect(instructionsFingerprint(row({ horizon: 'short' }) as never)).not.toBe(base);
    expect(instructionsFingerprint(row({ blocked_symbols: ['XOM'] }) as never)).not.toBe(base);
  });

  it('shows stored conflicts only while they describe the agent and are not dismissed', () => {
    const fingerprint = instructionsFingerprint(row() as never);
    const check = { fingerprint, conflicts: [CONFLICT], checked_at: '2026-10-19T08:00:00Z', dismissed: false };
    expect(currentConflicts(row({ instructions_check: check }) as never)).toEqual([CONFLICT]);
    expect(currentConflicts(row({ instructions_check: { ...check, dismissed: true } }) as never)).toBeNull();
    expect(currentConflicts(row({ instructions_check: check, horizon: 'short' }) as never)).toBeNull();
    expect(currentConflicts(row({ instructions_check: { ...check, conflicts: [] } }) as never)).toBeNull();
    const unknown = { ...check, conflicts: [{ setting: 'mood', quote: 'x' }] };
    expect(currentConflicts(row({ instructions_check: unknown }) as never)).toBeNull();
  });
});

describe('the check route (D176-D178)', () => {
  let ai: ReturnType<typeof createFakeAi>;
  let send: (path: string) => Promise<Response>;

  beforeEach(async () => {
    vi.clearAllMocks();
    stored = row();
    resetConfigForTests();
    ai = createFakeAi();
    const app = createApp(loadConfig(ENV), ai);
    const cookie = sessionCookie();
    send = (path) => Promise.resolve(app.request(path, { method: 'POST', headers: { ...ORIGIN, cookie } }));
  });

  it('stores what the check found, with the fingerprint of what it judged', async () => {
    ai.checkMandate = vi.fn(async () => ({ status: 'checked' as const, reason: null, conflicts: [CONFLICT] }));
    const response = await send(`/agents/${AGENT}/instructions-check`);
    expect(await response.json()).toEqual({ status: 'checked', reason: null, conflicts: [CONFLICT] });
    expect(queries.saveInstructionsCheck).toHaveBeenCalledWith(
      USER.id,
      AGENT,
      expect.objectContaining({ fingerprint: instructionsFingerprint(row() as never), conflicts: [CONFLICT], dismissed: false }),
    );
  });

  it('stores nothing when the agent changed while the model was asked', async () => {
    ai.checkMandate = vi.fn(async () => {
      stored = row({ persona: 'Something newer.' });
      return { status: 'checked' as const, reason: null, conflicts: [CONFLICT] };
    });
    await send(`/agents/${AGENT}/instructions-check`);
    expect(queries.saveInstructionsCheck).not.toHaveBeenCalled();
  });

  it('skips without a model call when there are no instructions, and quietly when the AI service is down', async () => {
    const checkMandate = vi.fn(async () => {
      throw new Error('unreachable');
    });
    ai.checkMandate = checkMandate;
    stored = row({ persona: '  ' });
    expect(await (await send(`/agents/${AGENT}/instructions-check`)).json()).toMatchObject({
      status: 'skipped',
      reason: 'no_instructions',
    });
    expect(checkMandate).not.toHaveBeenCalled();
    stored = row();
    expect(await (await send(`/agents/${AGENT}/instructions-check`)).json()).toMatchObject({
      status: 'skipped',
      reason: 'failed',
    });
    expect(queries.saveInstructionsCheck).not.toHaveBeenCalled();
  });

  it('refuses the real portfolio, and dismisses only the check for what the agent holds now', async () => {
    expect((await send(`/agents/${PRIMARY}/instructions-check`)).status).toBe(409);
    expect((await send(`/agents/${AGENT}/instructions-check/dismiss`)).status).toBe(204);
    expect(queries.dismissInstructionsCheck).toHaveBeenCalledWith(USER.id, AGENT, instructionsFingerprint(row() as never));
  });
});
