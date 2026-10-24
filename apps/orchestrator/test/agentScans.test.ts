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
import { ACTIVE_SESSION, sessionCookie } from './session.js';

const USER = { ...ACTIVE_SESSION, id: '00000000-0000-0000-0000-000000000001', email: null, base_currency: 'USD', timezone: 'Asia/Jerusalem' };
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
  getSessionUser: vi.fn(async (userId: string) => (await import('./session.js')).mockedSessionUser(userId)),
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
  answer: { trades: [], thesis: 'Nothing fits.', problems: [] },
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
  const cookie = sessionCookie();
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
    expect(await response.json()).toEqual({ ...RESULT, proposal_ids: [] });
    expect(scanAgent).toHaveBeenCalledWith(AGENT, { user_id: USER.id, trigger: 'manual' }, expect.anything());
  });

  it('writes the proposal a trade scan made, and returns its id beside the scan', async () => {
    const trade = {
      ...RESULT,
      outcome: 'trade',
      answer: {
        trades: [
          {
            decision: 'buy', symbol: 'INTC', quantity: '3', thesis: 'INTC fell 3.18% to 112.50.',
            price_minor: 11_250, price_as_of: '2026-10-07T13:00:00Z', funded_by: [], refused: false, problems: [],
          },
        ],
        thesis: null,
        problems: [],
      },
    };
    const { send } = await signedIn(async () => trade);
    const response = await send(`/agents/${AGENT}/scans`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...trade, proposal_ids: ['p-trade'] });
    const queries = await import('../src/db/queries.js');
    expect(queries.createTradeProposal).toHaveBeenCalledWith(
      expect.objectContaining({ scanId: RESULT.scan_id, agentId: AGENT, kind: 'buy' }),
    );
  });

  it.each([
    ['the real portfolio', PRIMARY, {}, 409, 'primary_agent_is_passive'],
    ['a paused agent', AGENT, { state: 'paused' }, 409, 'agent_not_active'],
    ['an agent with neither instructions nor settings', AGENT, { persona: '  ' }, 409, 'no_persona'],
    ['an unknown agent', '90000000-0000-0000-0000-0000000000ff', {}, 404, 'not_found'],
  ])('refuses %s before any model is paid for', async (_label, id, overrides, status, code) => {
    agent = agentRow(overrides);
    const { send, scanAgent } = await signedIn(async () => RESULT);
    const response = await send(`/agents/${id}/scans`);
    expect(response.status).toBe(status);
    expect(((await response.json()) as { error: string }).error).toBe(code);
    expect(scanAgent).not.toHaveBeenCalled();
  });

  it('scans an agent with settings and no instructions (D174)', async () => {
    agent = agentRow({ persona: null, max_position_bps: 1000 });
    const { send, scanAgent } = await signedIn(async () => RESULT);
    expect((await send(`/agents/${AGENT}/scans`)).status).toBe(200);
    expect(scanAgent).toHaveBeenCalled();
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
    // The code the agent page translates; the generic `ai_service_error` left it in English.
    expect(((await response.json()) as { error: string }).error).toBe('no_model');
  });
});

const SCAN = 'b0000000-0000-0000-0000-000000000001';

function proposalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p-1',
    symbol: 'NVDA',
    state: 'pending',
    // Past its deadline, not yet swept: it reads expired.
    expires_at: new Date(Date.now() - 1000).toISOString(),
    snoozed_until: null,
    decided_at: null,
    fill_id: null,
    ...overrides,
  };
}

/** A scan stored before D197: the answer is its one trade. */
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
    proposals: [proposalRow()],
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
          id: SCAN, outcome: 'trade', costMicroUsd: 41_000, problems: [],
          trades: [
            {
              decision: 'buy', symbol: 'NVDA', quantity: '2', thesis: 'NVDA fell 2.1%.', fundedBy: [],
              refused: false, problems: [], proposal: { id: 'p-1', state: 'expired' }, fillId: null,
            },
          ],
        }),
      ],
      nextBefore: null,
    });
    expect(body.scans[0]).not.toHaveProperty('transcript');
  });

  it('lists each trade of a scan with its own proposal, and a refused one with why (D197)', async () => {
    const queries = await import('../src/db/queries.js');
    const answer = {
      trades: [
        { decision: 'sell', symbol: 'MSFT', quantity: '2', thesis: 'MSFT is rich.', funded_by: [] },
        { decision: 'buy', symbol: 'NVDA', quantity: '2', thesis: 'NVDA fell.', funded_by: ['MSFT'] },
        { decision: 'buy', symbol: 'TSLA', quantity: '1', thesis: 't', refused: true, problems: ['TSLA is not tradable'] },
      ],
      thesis: null,
      problems: ['TSLA is not tradable'],
    };
    const proposals = [
      proposalRow({ id: 'p-sell', symbol: 'MSFT', state: 'approved', decided_at: new Date().toISOString(), fill_id: 'f-1' }),
      proposalRow({ id: 'p-buy', symbol: 'NVDA', expires_at: new Date(Date.now() + 60_000).toISOString() }),
    ];
    vi.mocked(queries.listAgentScans).mockResolvedValueOnce([scanRow({ answer, proposals })] as never);
    const { get } = await signedIn(async () => RESULT);
    const [scan] = (await (await get(`/agents/${AGENT}/scans`)).json()).scans;
    expect(scan.trades.map((t: { symbol: string; proposal: unknown; fillId: unknown; refused: boolean }) => [t.symbol, t.proposal, t.fillId, t.refused])).toEqual([
      ['MSFT', { id: 'p-sell', state: 'approved' }, 'f-1', false],
      ['NVDA', { id: 'p-buy', state: 'pending' }, null, false],
      ['TSLA', null, null, true],
    ]);
    expect(scan.trades[1].fundedBy).toEqual(['MSFT']);
    expect(scan.trades[2].problems).toEqual(['TSLA is not tradable']);
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
      ...scanRow({ proposals: [proposalRow({ fill_id: 'f-1', state: 'approved', decided_at: new Date().toISOString() })] }),
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
      // A one-trade answer from before D197: its thesis is the trade's, shown once, under it.
      thesis: null,
      trades: [
        expect.objectContaining({ thesis: 'NVDA fell 2.1%.', proposal: { id: 'p-1', state: 'approved' }, fillId: 'f-1' }),
      ],
      transcript: [
        { role: 'assistant', text: 'Checking NVDA.', toolCalls: [{ id: 'c1', name: 'get_quote', arguments: { symbol: 'NVDA' } }] },
        { role: 'tool', callId: 'c1', name: 'get_quote', result: { price: '237.14' } },
      ],
    });
  });

  it('reads a refused one-trade answer from before D197 as a trade not proposed, with its reasons', async () => {
    const queries = await import('../src/db/queries.js');
    const answer = { decision: 'buy', symbol: 'IRON', quantity: '3', thesis: 't', problems: ['figures not in the evidence: 39.69'] };
    vi.mocked(queries.listAgentScans).mockResolvedValueOnce([
      scanRow({ outcome: 'invalid_answer', answer, proposals: [] }),
    ] as never);
    const { get } = await signedIn(async () => RESULT);
    const [scan] = (await (await get(`/agents/${AGENT}/scans`)).json()).scans;
    expect(scan.trades).toEqual([
      expect.objectContaining({ symbol: 'IRON', refused: true, problems: ['figures not in the evidence: 39.69'], proposal: null }),
    ]);
  });

  it("keeps a pass's reason, from either shape of answer", async () => {
    const queries = await import('../src/db/queries.js');
    const { get } = await signedIn(async () => RESULT);
    for (const answer of [
      { decision: 'none', thesis: 'Nothing fits.' },
      { trades: [], thesis: 'Nothing fits.', problems: [] },
    ]) {
      vi.mocked(queries.getAgentScan).mockResolvedValueOnce({
        ...scanRow({ outcome: 'no_trade', answer, proposals: [] }),
        briefing: {},
        transcript: [],
      } as never);
      const body = await (await get(`/agents/${AGENT}/scans/${SCAN}`)).json();
      expect(body).toMatchObject({ thesis: 'Nothing fits.', trades: [] });
    }
  });

  it('marks only a pass the AI service flagged for not explaining its idle cash (D237)', async () => {
    const queries = await import('../src/db/queries.js');
    vi.mocked(queries.listAgentScans).mockResolvedValueOnce([
      scanRow({ outcome: 'no_trade', proposals: [], answer: { trades: [], thesis: 'Nothing fits.', cash_unjustified: true } }),
      scanRow({ outcome: 'no_trade', proposals: [], answer: { trades: [], thesis: 'Nothing fits.', problems: [] } }),
    ] as never);
    const { get } = await signedIn(async () => RESULT);
    const body = await (await get(`/agents/${AGENT}/scans`)).json();
    expect(body.scans.map((scan: { cashUnjustified: boolean }) => scan.cashUnjustified)).toEqual([true, false]);
  });

  it('is a 404 for a scan that is not this agent\'s, or an id that is not one', async () => {
    const { get } = await signedIn(async () => RESULT);
    expect((await get(`/agents/${AGENT}/scans/${SCAN}`)).status).toBe(404);
    expect((await get(`/agents/${AGENT}/scans/not-an-id`)).status).toBe(404);
    expect((await get(`/agents/90000000-0000-0000-0000-0000000000ff/scans`)).status).toBe(404);
  });
});
