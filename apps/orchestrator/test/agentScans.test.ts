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
  getUser: vi.fn(async () => USER),
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
  Object.assign(ai, { scanAgent: vi.fn(scanAgent) });
  const app = createApp(loadConfig(ENV), ai);
  const login = await app.request('/auth/login', {
    method: 'POST',
    headers: ORIGIN,
    body: JSON.stringify({ passphrase: 'test-passphrase' }),
  });
  const cookie = (login.headers.get('set-cookie') as string).split(';')[0]!;
  const send = (path: string) => app.request(path, { method: 'POST', headers: { ...ORIGIN, cookie } });
  return { send, scanAgent: (ai as unknown as { scanAgent: ReturnType<typeof vi.fn> }).scanAgent };
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
    expect(await response.json()).toEqual(RESULT);
    expect(scanAgent).toHaveBeenCalledWith(AGENT, { user_id: USER.id, trigger: 'manual' }, expect.anything());
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
