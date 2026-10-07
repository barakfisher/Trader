/**
 * `POST /agents/:id/scans` (Stage 4, PR 4): who may scan, and what is passed on.
 *
 * The database is mocked and the AI service faked: the scan itself is tested in
 * the AI service over real SQL. Pinned here: the refusals are made before the AI
 * service is asked (no model is paid for an agent that cannot scan), the scan's
 * result is returned as the service gave it, and the service's own refusals keep
 * their codes.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AiServiceError } from '@traders/shared/ai';

import { createFakeAi } from './fakeAi.js';

const USER = { id: '00000000-0000-0000-0000-000000000001', email: null, base_currency: 'USD', timezone: 'Asia/Jerusalem' };
const PRIMARY = '90000000-0000-0000-0000-000000000001';
const AGENT = '90000000-0000-0000-0000-0000000000a1';

function agentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT,
    slug: 'agent-1',
    name: 'Value',
    persona: 'A patient value investor.',
    is_primary: false,
    budget_minor: '100000',
    currency: 'USD',
    state: 'active',
    created_at: new Date('2026-10-05T10:00:00Z'),
    holdings_count: 0,
    cash_minor: '100000',
    ...overrides,
  };
}

let agent = agentRow();

vi.mock('../src/db/pool.js', () => ({
  queryOne: vi.fn(async () => ({ ok: 1 })),
  query: vi.fn(async () => []),
  transaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({})),
  initPool: vi.fn(),
  getPool: vi.fn(),
  closePool: vi.fn(),
}));

vi.mock('../src/db/queries.js', () => ({
  findTradableInstrument: vi.fn(async () => ({
    id: 'i-intc', symbol: 'INTC', name: 'Intel', asset_class: 'equity', exchange: 'NMS', currency: 'USD', membership: 'screened',
  })),
  createTradeProposal: vi.fn(async () => ({ proposalId: 'p-trade', observationId: 'o-trade' })),
  getUser: vi.fn(async () => USER),
  getOrCreateUserSettings: vi.fn(async () => ({
    notify_severity: 'high',
    quiet_hours_start: null,
    quiet_hours_end: null,
    muted_until: null,
    language: 'en',
  })),
  claimNotification: vi.fn(async () => ({ id: 'n-1' })),
  listAgentScans: vi.fn(async () => []),
  getAgentScan: vi.fn(async () => null),
  settleNotification: vi.fn(async () => undefined),
  getAgent: vi.fn(async (_u: string, id: string) =>
    id === PRIMARY ? agentRow({ id: PRIMARY, is_primary: true }) : id === AGENT ? agent : null,
  ),
}));

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
const ORIGIN = { origin: 'http://localhost:5173', 'content-type': 'application/json' };

const RESULT = {
  scan_id: 'b0000000-0000-0000-0000-000000000001',
  outcome: 'no_trade',
  steps: 2,
  cost_micro_usd: 41000,
  model: 'anthropic/claude-sonnet-5.5',
  answer: { decision: 'none', symbol: null, quantity: null, thesis: 'Nothing fits.', problems: [] },
  error: null,
};

async function signedIn(scanAgent: (...args: unknown[]) => Promise<unknown>) {
  resetConfigForTests();
  const ai = createFakeAi();
  Object.assign(ai, {
    scanAgent: vi.fn(scanAgent),
    marketCalendar: vi.fn(async () => ({ is_open: false, next_open: '2026-10-08T13:30:00Z' })),
  });
  const app = createApp(loadConfig(ENV), ai);
  const login = await app.request('/auth/login', {
    method: 'POST',
    headers: ORIGIN,
    body: JSON.stringify({ passphrase: 'test-passphrase' }),
  });
  const cookie = (login.headers.get('set-cookie') as string).split(';')[0]!;
  const send = (path: string) => app.request(path, { method: 'POST', headers: { ...ORIGIN, cookie } });
  const get = (path: string) => app.request(path, { headers: { ...ORIGIN, cookie } });
  return { send, get, scanAgent: (ai as unknown as { scanAgent: ReturnType<typeof vi.fn> }).scanAgent };
}

beforeEach(() => {
  vi.clearAllMocks();
  agent = agentRow();
});

describe('running a scan', () => {
  it('asks the AI service for the signed-in user and returns its result', async () => {
    const { send, scanAgent } = await signedIn(async () => RESULT);
    const response = await send(`/agents/${AGENT}/scans`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...RESULT, proposal_id: null });
    expect(scanAgent).toHaveBeenCalledWith(AGENT, { user_id: USER.id, trigger: 'manual' }, expect.anything());
  });

  it('writes the proposal a trade scan made, and returns its id beside the scan', async () => {
    const trade = {
      ...RESULT,
      outcome: 'trade',
      answer: {
        decision: 'buy', symbol: 'INTC', quantity: '3', thesis: 'INTC fell 3.18% to 112.50.',
        price_minor: 11_250, price_as_of: '2026-10-07T13:00:00Z', problems: [],
      },
    };
    const { send } = await signedIn(async () => trade);
    const response = await send(`/agents/${AGENT}/scans`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...trade, proposal_id: 'p-trade' });
    const queries = await import('../src/db/queries.js');
    expect(queries.createTradeProposal).toHaveBeenCalledWith(
      expect.objectContaining({ scanId: RESULT.scan_id, agentId: AGENT, kind: 'buy' }),
    );
  });

  it.each([
    ['the real portfolio', PRIMARY, {}, 409, 'primary_agent_is_passive'],
    ['a paused agent', AGENT, { state: 'paused' }, 409, 'agent_not_active'],
    ['an agent with no persona', AGENT, { persona: '  ' }, 409, 'no_persona'],
    ['an unknown agent', '90000000-0000-0000-0000-0000000000ff', {}, 404, 'not_found'],
  ])('refuses %s before any model is paid for', async (_label, id, overrides, status, code) => {
    agent = agentRow(overrides);
    const { send, scanAgent } = await signedIn(async () => RESULT);
    const response = await send(`/agents/${id}/scans`);
    expect(response.status).toBe(status);
    expect(((await response.json()) as { error: string }).error).toBe(code);
    expect(scanAgent).not.toHaveBeenCalled();
  });

  it("keeps the AI service's refusal code: a scan already running", async () => {
    const { send } = await signedIn(async () => {
      throw new AiServiceError('AI service 409', 409, {
        detail: { code: 'scan_running', message: 'this agent is already scanning' },
      });
    });
    const response = await send(`/agents/${AGENT}/scans`);
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe('scan_running');
  });

  it('says a model must be chosen when none is configured', async () => {
    const { send } = await signedIn(async () => {
      throw new AiServiceError('AI service 503', 503, { detail: { code: 'no_model', message: 'x' } });
    });
    const response = await send(`/agents/${AGENT}/scans`);
    expect(response.status).toBe(503);
  });
});

const SCAN = 'b0000000-0000-0000-0000-000000000001';

function scanRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SCAN,
    trigger: 'manual',
    started_at: new Date('2026-10-07T15:00:00Z'),
    finished_at: new Date('2026-10-07T15:00:12Z'),
    outcome: 'trade',
    steps: 2,
    cost_micro_usd: '41000',
    model: 'anthropic/claude-sonnet-5.5',
    answer: { decision: 'buy', symbol: 'NVDA', quantity: '2', thesis: 'NVDA fell 2.1%.', price_minor: 23714 },
    error: null,
    proposal_id: 'p-1',
    proposal_state: 'pending',
    // Past its deadline, not yet swept: it reads expired.
    proposal_expires_at: new Date(Date.now() - 1000),
    proposal_snoozed_until: null,
    proposal_decided_at: null,
    fill_id: null,
    ...overrides,
  };
}

describe('the Decisions tab (D50)', () => {
  it('lists scans as summaries, with the proposal in its state now', async () => {
    const queries = await import('../src/db/queries.js');
    vi.mocked(queries.listAgentScans).mockResolvedValueOnce([scanRow()] as never);
    const { get } = await signedIn(async () => RESULT);
    const response = await get(`/agents/${AGENT}/scans`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      scans: [
        expect.objectContaining({
          id: SCAN, outcome: 'trade', costMicroUsd: 41_000, decision: 'buy', symbol: 'NVDA', quantity: '2',
          proposal: { id: 'p-1', state: 'expired' }, fillId: null, problems: [],
        }),
      ],
      nextBefore: null,
    });
    expect(body.scans[0]).not.toHaveProperty('transcript');
  });

  it('offers an older page only when one exists', async () => {
    const queries = await import('../src/db/queries.js');
    const { SCANS_PAGE_SIZE } = await import('../src/http/routes/agentScans.js');
    const rows = Array.from({ length: SCANS_PAGE_SIZE + 1 }, (_, i) =>
      scanRow({ id: `s-${i}`, started_at: new Date(Date.parse('2026-10-07T15:00:00Z') - i * 60_000) }),
    );
    vi.mocked(queries.listAgentScans).mockResolvedValueOnce(rows as never);
    const { get } = await signedIn(async () => RESULT);
    const body = await (await get(`/agents/${AGENT}/scans?before=2026-10-08T00:00:00Z`)).json();
    expect(body.scans).toHaveLength(SCANS_PAGE_SIZE);
    expect(body.nextBefore).toBe(rows[SCANS_PAGE_SIZE - 1]!.started_at.toISOString());
    expect(queries.listAgentScans).toHaveBeenCalledWith(USER.id, AGENT, {
      limit: SCANS_PAGE_SIZE + 1,
      before: new Date('2026-10-08T00:00:00Z'),
    });
    expect((await get(`/agents/${AGENT}/scans?before=yesterday`)).status).toBe(400);
  });

  it('gives one scan in full: the briefing, every step, the thesis', async () => {
    const queries = await import('../src/db/queries.js');
    vi.mocked(queries.getAgentScan).mockResolvedValueOnce({
      ...scanRow({ fill_id: 'f-1', proposal_state: 'approved', proposal_decided_at: new Date() }),
      briefing: { cash: '10000.00' },
      transcript: [
        { role: 'assistant', text: 'Checking NVDA.', tool_calls: [{ id: 'c1', name: 'get_quote', arguments: { symbol: 'NVDA' } }] },
        { role: 'tool', call_id: 'c1', name: 'get_quote', result: { price: '237.14' } },
        { role: 'mystery' },
      ],
    } as never);
    const { get } = await signedIn(async () => RESULT);
    const body = await (await get(`/agents/${AGENT}/scans/${SCAN}`)).json();
    expect(body).toMatchObject({
      briefing: { cash: '10000.00' },
      thesis: 'NVDA fell 2.1%.',
      proposal: { id: 'p-1', state: 'approved' },
      fillId: 'f-1',
      transcript: [
        { role: 'assistant', text: 'Checking NVDA.', toolCalls: [{ id: 'c1', name: 'get_quote', arguments: { symbol: 'NVDA' } }] },
        { role: 'tool', callId: 'c1', name: 'get_quote', result: { price: '237.14' } },
      ],
    });
  });

  it('is a 404 for a scan that is not this agent\'s, or an id that is not one', async () => {
    const { get } = await signedIn(async () => RESULT);
    expect((await get(`/agents/${AGENT}/scans/${SCAN}`)).status).toBe(404);
    expect((await get(`/agents/${AGENT}/scans/not-an-id`)).status).toBe(404);
    expect((await get(`/agents/90000000-0000-0000-0000-0000000000ff/scans`)).status).toBe(404);
  });
});
