/**
 * Research on the main portfolio, the orchestrator's side (D254, D289-D293): the
 * page's read with its stale mark, the assignment, and starting a run with the AI
 * service's refusals passed on. The database layer is mocked; the SQL runs in
 * queries.postgres.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PAYER_REFUSALS, RESEARCH_REFUSALS, RESEARCH_STALE_DAYS } from '@traders/shared';
import { AiServiceError } from '@traders/shared/ai';

import { ACTIVE_SESSION, sessionCookie } from './session.js';

const USER = {
  ...ACTIVE_SESSION,
  id: '00000000-0000-0000-0000-000000000001',
  email: null,
  base_currency: 'USD',
  timezone: 'Asia/Jerusalem',
};
const AGENT = '90000000-0000-0000-0000-0000000000a1';
const NOW = new Date('2026-10-24T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function holding(overrides: Record<string, unknown> = {}) {
  return {
    instrument_id: '10000000-0000-0000-0000-000000000001',
    symbol: 'CCJ',
    name: 'Cameco',
    rating: 'bullish',
    rationale: 'CCJ trades at 54.32.',
    findings: ['Steady news.'],
    rated_at: new Date(NOW.getTime() - DAY),
    agent_name: 'Analyst',
    last_status: 'rated',
    last_at: new Date(NOW.getTime() - DAY),
    ...overrides,
  };
}

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
  getResearchAgent: vi.fn(async () => ({ id: AGENT, name: 'Analyst', state: 'active' })),
  getLatestResearchRun: vi.fn(async () => null),
  listResearchHoldings: vi.fn(async () => [holding()]),
  setResearchAgent: vi.fn(async () => true),
}));

const { loadConfig, resetConfigForTests } = await import('../src/config.js');
const { createApp } = await import('../src/http/app.js');
const { RATE_LIMITS } = await import('../src/http/rateLimits.js');
const { isStale, toResearchHolding } = await import('../src/services/research.js');
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

describe('a holding as the page reads it (D293)', () => {
  it('is stale only past the set age', () => {
    expect(isStale(new Date(NOW.getTime() - RESEARCH_STALE_DAYS * DAY), NOW)).toBe(false);
    expect(isStale(new Date(NOW.getTime() - RESEARCH_STALE_DAYS * DAY - 1), NOW)).toBe(true);
  });

  it("carries the agent's latest rating with its name and date", () => {
    expect(toResearchHolding(holding() as never, NOW)).toEqual({
      instrumentId: '10000000-0000-0000-0000-000000000001',
      symbol: 'CCJ',
      name: 'Cameco',
      latest: {
        rating: 'bullish',
        rationale: 'CCJ trades at 54.32.',
        findings: ['Steady news.'],
        agentName: 'Analyst',
        ratedAt: new Date(NOW.getTime() - DAY).toISOString(),
        stale: false,
      },
      lastAttempt: null,
    });
  });

  it('says when the newest attempt was refused, and keeps the rating before it', () => {
    const at = new Date(NOW.getTime() - 1000);
    const read = toResearchHolding(holding({ last_status: 'refused', last_at: at }) as never, NOW);
    expect(read.latest?.rating).toBe('bullish');
    expect(read.lastAttempt).toEqual({ status: 'refused', at: at.toISOString() });
  });

  it('has no rating before the first', () => {
    const read = toResearchHolding(
      holding({ rating: null, rationale: null, findings: null, rated_at: null, agent_name: null, last_status: null, last_at: null }) as never,
      NOW,
    );
    expect(read).toMatchObject({ latest: null, lastAttempt: null });
  });
});

describe('the research routes', () => {
  let ai: ReturnType<typeof createFakeAi>;
  let send: (method: string, path: string, body?: unknown) => Promise<Response>;

  /** A new app: its in-memory rate limits start empty. */
  function fresh(): void {
    resetConfigForTests();
    ai = createFakeAi();
    const app = createApp(loadConfig(ENV), ai);
    const cookie = sessionCookie();
    send = (method, path, body) =>
      Promise.resolve(
        app.request(path, {
          method,
          headers: { ...ORIGIN, cookie },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    fresh();
  });

  it('reads the assigned agent and each holding', async () => {
    const response = await send('GET', '/research');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.agent).toEqual({ id: AGENT, name: 'Analyst', state: 'active' });
    expect(body.holdings.map((h: { symbol: string }) => h.symbol)).toEqual(['CCJ']);
    expect(queries.listResearchHoldings).toHaveBeenCalledWith(USER.id, AGENT);
  });

  it("assigns one of the user's agents, or none, and refuses another's", async () => {
    expect((await send('PUT', '/research/agent', { agentId: AGENT })).status).toBe(200);
    expect(queries.setResearchAgent).toHaveBeenCalledWith(USER.id, AGENT);
    expect((await send('PUT', '/research/agent', { agentId: null })).status).toBe(200);
    vi.mocked(queries.setResearchAgent).mockResolvedValueOnce(false);
    expect((await send('PUT', '/research/agent', { agentId: AGENT })).status).toBe(404);
    expect((await send('PUT', '/research/agent', { agentId: 'nope' })).status).toBe(400);
  });

  it('starts a run now and answers 202', async () => {
    const start = vi.fn(ai.startResearch);
    ai.startResearch = start;
    const response = await send('POST', '/research/runs');
    expect(response.status).toBe(202);
    expect(start).toHaveBeenCalledWith({ user_id: USER.id, trigger: 'manual' }, expect.anything());
  });

  it('is rate limited per user (D257)', async () => {
    for (let n = 0; n < RATE_LIMITS.researchRun.points; n += 1) {
      expect((await send('POST', '/research/runs')).status).toBe(202);
    }
    expect((await send('POST', '/research/runs')).status).toBe(429);
  });

  it("passes the AI service's refusals on with their codes", async () => {
    for (const code of [...RESEARCH_REFUSALS, ...PAYER_REFUSALS]) {
      fresh();
      ai.startResearch = vi.fn(async () => {
        throw new AiServiceError(code, 409, { detail: { code, message: code } });
      });
      const response = await send('POST', '/research/runs');
      expect(response.status, code).toBe(409);
      expect((await response.json()).error, code).toBe(code);
    }
  });
});
