/**
 * The agent review's routes (D335-D338) with the database mocked: the open
 * suggestions as the page reads them, Apply answering the agent as it now is
 * or a refusal with its own code, and Dismiss. The SQL itself - a setting
 * written only while it is what the review read - is pinned in
 * `queries.postgres.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createFakeAi } from './fakeAi.js';
import { ACTIVE_SESSION, sessionCookie } from './session.js';

const USER = { ...ACTIVE_SESSION, id: '00000000-0000-0000-0000-000000000001' };
const PRIMARY = '90000000-0000-0000-0000-000000000001';
const AGENT = '90000000-0000-0000-0000-0000000000a1';
const SUGGESTION = '70000000-0000-0000-0000-000000000001';

function agentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT,
    slug: 'agent-1',
    name: 'Momentum',
    persona: 'Patient.',
    is_primary: false,
    budget_minor: '100000',
    currency: 'USD',
    state: 'active',
    created_at: new Date('2026-10-05T10:00:00Z'),
    holdings_count: 0,
    cash_minor: '100000',
    llm_budget_micro_usd: '500000',
    risk_level: 3,
    horizon: null,
    thesis_style: null,
    max_position_bps: null,
    cash_buffer_bps: null,
    max_holdings: null,
    allow_etfs: true,
    market_caps: ['mega', 'large', 'mid'],
    sectors: [],
    industries: [],
    etf_categories: [],
    blocked_symbols: [],
    instructions_check: null,
    scan_every_hours: null,
    scan_pre_open: true,
    scan_post_close: false,
    max_decisions: 1,
    model: null,
    ...overrides,
  };
}

const OPEN = {
  id: SUGGESTION,
  agent_id: AGENT,
  rule: 'idle_cash',
  status: 'open',
  evidence: { scans: 10, tradeScans: 0, since: '2026-10-19T13:00:00.000Z', currency: 'USD', cashMinor: 100000 },
  change: { setting: 'market_caps', from: ['mega', 'large'], to: ['mega', 'large', 'mid'] },
  created_at: new Date('2026-10-27T13:00:00Z'),
  decided_at: null,
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
  getSessionUser: vi.fn(async (userId: string) => (await import('./session.js')).mockedSessionUser(userId)),
  getUser: vi.fn(async () => ({ ...USER, email: null, base_currency: 'USD', timezone: 'Asia/Jerusalem' })),
  getAgent: vi.fn(async (_u: string, id: string) =>
    id === PRIMARY ? agentRow({ id: PRIMARY, is_primary: true, budget_minor: null, cash_minor: null }) : id === AGENT ? agentRow() : null,
  ),
  listOpenSuggestions: vi.fn(async () => [OPEN]),
  applySuggestion: vi.fn(async () => ({ status: 'applied' })),
  dismissSuggestion: vi.fn(async () => true),
}));

const queries = await import('../src/db/queries.js');
const { loadConfig, resetConfigForTests } = await import('../src/config.js');
const { createApp } = await import('../src/http/app.js');

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

async function signedIn() {
  resetConfigForTests();
  const app = createApp(loadConfig(ENV), createFakeAi());
  const cookie = sessionCookie();
  return (method: string, path: string) => app.request(path, { method, headers: { ...ORIGIN, cookie } });
}

beforeEach(() => vi.clearAllMocks());

describe('the open suggestions', () => {
  it('lists them with their evidence and change, for the signed-in user', async () => {
    const send = await signedIn();
    const response = await send('GET', `/agents/${AGENT}/suggestions`);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({
      suggestions: [
        {
          id: SUGGESTION,
          rule: 'idle_cash',
          status: 'open',
          createdAt: '2026-10-27T13:00:00.000Z',
          evidence: OPEN.evidence,
          change: OPEN.change,
        },
      ],
    });
    expect(queries.listOpenSuggestions).toHaveBeenCalledWith(USER.id, AGENT);
  });

  it('has none for the real portfolio (D1)', async () => {
    const send = await signedIn();
    const response = await send('GET', `/agents/${PRIMARY}/suggestions`);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'primary_agent_is_passive' });
  });
});

describe('Apply', () => {
  it('answers the agent as it now is', async () => {
    const send = await signedIn();
    const response = await send('POST', `/agents/${AGENT}/suggestions/${SUGGESTION}/apply`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: AGENT, mandate: expect.objectContaining({ marketCaps: ['mega', 'large', 'mid'] }) });
    expect(queries.applySuggestion).toHaveBeenCalledWith(USER.id, AGENT, SUGGESTION);
  });

  it.each([
    ['not_found', 404, 'not_found'],
    ['closed', 409, 'suggestion_closed'],
    ['nothing_to_apply', 409, 'nothing_to_apply'],
    ['agent_archived', 409, 'agent_archived'],
    ['stale', 409, 'suggestion_stale'],
  ] as const)('refuses %s with %i %s', async (status, http, code) => {
    vi.mocked(queries.applySuggestion).mockResolvedValueOnce({ status });
    const send = await signedIn();
    const response = await send('POST', `/agents/${AGENT}/suggestions/${SUGGESTION}/apply`);
    expect(response.status).toBe(http);
    expect(await response.json()).toMatchObject({ error: code });
  });

  it('refuses a malformed id before any lookup', async () => {
    const send = await signedIn();
    expect((await send('POST', `/agents/${AGENT}/suggestions/not-an-id/apply`)).status).toBe(400);
    expect(queries.applySuggestion).not.toHaveBeenCalled();
  });
});

describe('Dismiss', () => {
  it('closes an open suggestion, and answers 404 for one that is not open', async () => {
    const send = await signedIn();
    expect((await send('POST', `/agents/${AGENT}/suggestions/${SUGGESTION}/dismiss`)).status).toBe(204);
    expect(queries.dismissSuggestion).toHaveBeenCalledWith(USER.id, AGENT, SUGGESTION);
    vi.mocked(queries.dismissSuggestion).mockResolvedValueOnce(false);
    expect((await send('POST', `/agents/${AGENT}/suggestions/${SUGGESTION}/dismiss`)).status).toBe(404);
  });
});
