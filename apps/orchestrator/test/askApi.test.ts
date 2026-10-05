/**
 * `POST /ask`: what this side adds, and what it must not change.
 *
 * Two properties carry this file. The portfolio must travel with *every*
 * question, because routing happens in the AI service and a second classifier
 * here could disagree with it - and the failure when it does is silent: a
 * portfolio question refused for missing data the caller actually had. And a
 * refusal must reach the browser as a 200, because rewriting it to a 4xx would
 * make "the corpus does not cover that" indistinguishable from "the corpus
 * failed to load", which is the exact distinction the relevance floor exists to
 * draw.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = {
  id: '00000000-0000-0000-0000-000000000001',
  email: null,
  base_currency: 'USD',
  timezone: 'Asia/Jerusalem',
};

const HOLDING_ROWS = [{ id: 'h1', symbol: 'VOO' }];

const listHoldings = vi.fn(async () => HOLDING_ROWS);
const listTargetWeights = vi.fn(async () => [{ symbol: 'VOO', weight: '0.50' }]);

vi.mock('../src/db/pool.js', () => ({
  queryOne: vi.fn(async () => ({ ok: 1 })),
  query: vi.fn(async () => []),
  transaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({})),
  initPool: vi.fn(),
  getPool: vi.fn(),
  closePool: vi.fn(),
}));

vi.mock('../src/db/queries.js', () => ({
  primaryAgentId: vi.fn(async () => '90000000-0000-0000-0000-000000000001'),
  getUser: vi.fn(async () => USER),
  listHoldings: (...args: unknown[]) => listHoldings(...(args as [])),
  listTargetWeights: (...args: unknown[]) => listTargetWeights(...(args as [])),
}));

vi.mock('../src/services/valuation.js', () => ({
  valuePortfolio: vi.fn(async () => ({
    summary: { baseCurrency: 'USD' },
    holdings: [
      {
        instrument: { id: 'i1', symbol: 'VOO' },
        valueMinor: 1_250_000,
        quote: { asOf: '2026-09-24T00:00:00Z' },
      },
      // Unpriced, and it must survive the trip: `/ask` reports how many it
      // could not see rather than quietly totalling the rest.
      { instrument: { id: 'i2', symbol: 'XYZ' }, valueMinor: null, quote: null },
    ],
  })),
}));

const { loadConfig, resetConfigForTests } = await import('../src/config.js');
const { createApp } = await import('../src/http/app.js');
const { AiServiceError } = await import('@traders/shared/ai');

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

const ask = vi.fn();

function buildApp() {
  resetConfigForTests();
  return createApp(loadConfig(ENV), { ask } as never);
}

async function loginCookie(app: ReturnType<typeof buildApp>): Promise<string> {
  const response = await app.request('/auth/login', {
    method: 'POST',
    headers: ORIGIN,
    body: JSON.stringify({ passphrase: 'test-passphrase' }),
  });
  return (response.headers.get('set-cookie') as string).split(';')[0]!;
}

const ANSWER = {
  question: 'what is a drawdown',
  intent: 'concept',
  answered: true,
  text: 'From Drawdown - What it is: ...',
  citations: [],
  concept_refs: ['drawdown'],
  evidence: {},
  answer_source: 'extractive',
  fallback_reason: 'none',
  relevance: 'confident',
  best_similarity: 0.71,
  refused_reason: null,
  vector_is_semantic: true,
};

function post(app: ReturnType<typeof buildApp>, cookie: string, question: unknown) {
  return app.request('/ask', {
    method: 'POST',
    headers: { ...ORIGIN, cookie },
    body: JSON.stringify({ question }),
  });
}

describe('POST /ask', () => {
  let app: ReturnType<typeof buildApp>;
  let cookie: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    listHoldings.mockResolvedValue(HOLDING_ROWS);
    listTargetWeights.mockResolvedValue([{ symbol: 'VOO', weight: '0.50' }]);
    app = buildApp();
    cookie = await loginCookie(app);
  });

  it('passes the answer through', async () => {
    ask.mockResolvedValueOnce(ANSWER);

    const response = await post(app, cookie, 'what is a drawdown');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ answered: true });
  });

  it('sends the valued portfolio with every question, whatever it looks like', async () => {
    // Routing happens in the AI service. Deciding here whether a question needs
    // holdings would be a second classifier that can disagree with the first,
    // and the disagreement is silent.
    ask.mockResolvedValueOnce(ANSWER);

    await post(app, cookie, 'what is a drawdown');

    const payload = ask.mock.calls[0]![0] as { holdings: unknown[] };
    expect(payload.holdings).toHaveLength(2);
  });

  it('carries an unpriced holding through as null, never as zero', async () => {
    // A zero is indistinguishable from a real value, so an infrastructure
    // failure would render as a financial fact (guideline 14).
    ask.mockResolvedValueOnce(ANSWER);

    await post(app, cookie, 'what is my portfolio worth');

    const payload = ask.mock.calls[0]![0] as { holdings: { value_minor: number | null }[] };
    expect(payload.holdings.map((h) => h.value_minor)).toEqual([1_250_000, null]);
  });

  it('sends target weights as decimal strings', async () => {
    // A weight never becomes a number on this side of the wire (guideline 4).
    ask.mockResolvedValueOnce(ANSWER);

    await post(app, cookie, 'how far am I from my targets');

    const payload = ask.mock.calls[0]![0] as { target_weights: Record<string, unknown> };
    expect(payload.target_weights).toEqual({ VOO: '0.50' });
  });

  it('passes a refusal through as a 200, not an error', async () => {
    // Rewriting this to a 4xx would make a correct refusal look identical to a
    // corpus that failed to load.
    ask.mockResolvedValueOnce({
      ...ANSWER,
      answered: false,
      answer_source: 'none',
      relevance: 'none',
      refused_reason: 'not_in_corpus',
      best_similarity: 0.05,
    });

    const response = await post(app, cookie, 'how do I roast a chicken');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      answered: false,
      refused_reason: 'not_in_corpus',
    });
  });

  it('asks with no holdings when the portfolio is empty, rather than refusing', async () => {
    // A new account can still ask what a drawdown is.
    listHoldings.mockResolvedValueOnce([]);
    ask.mockResolvedValueOnce(ANSWER);

    const response = await post(app, cookie, 'what is a drawdown');

    expect(response.status).toBe(200);
    expect((ask.mock.calls[0]![0] as { holdings: unknown[] }).holdings).toEqual([]);
  });

  it('rejects an empty question before calling the AI service', async () => {
    const response = await post(app, cookie, '   ');

    expect(response.status).toBe(400);
    expect(ask).not.toHaveBeenCalled();
  });

  it('rejects a question longer than the AI service would accept', async () => {
    const response = await post(app, cookie, 'x'.repeat(1001));

    expect(response.status).toBe(400);
    expect(ask).not.toHaveBeenCalled();
  });

  it('reports an upstream failure as ours', async () => {
    ask.mockRejectedValueOnce(new AiServiceError('boom', 500));

    const response = await post(app, cookie, 'what is a drawdown');

    expect(response.status).toBe(502);
  });

  it('requires a session', async () => {
    const response = await app.request('/ask', {
      method: 'POST',
      headers: ORIGIN,
      body: JSON.stringify({ question: 'what is a drawdown' }),
    });

    expect(response.status).toBe(401);
    expect(ask).not.toHaveBeenCalled();
  });
});
