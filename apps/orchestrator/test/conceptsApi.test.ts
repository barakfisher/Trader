/**
 * The proxy in front of the concept corpus, and the one judgement it makes.
 *
 * A slug the corpus does not hold must reach the browser as a 404 saying no
 * explanation is available, while every other AI-service failure keeps its own
 * status. Collapsing the two would make a broken deployment look like a gap in
 * the documentation - and, worse, make an environment that simply never ran the
 * ingester look broken.
 *
 * The route is also behind the session gate. The corpus carries no `user_id`
 * and is shared reference material, but it is part of the product rather than a
 * public API, and an unauthenticated reader has no observation to have arrived
 * from.
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

vi.mock('../src/db/queries.js', () => ({
  getUser: vi.fn(async () => USER),
}));

const { loadConfig, resetConfigForTests } = await import('../src/config.js');
const { createApp } = await import('../src/http/app.js');
const { AiServiceError } = await import('@traders/shared/ai');

const DOCUMENT = {
  slug: 'drawdown',
  title: 'Drawdown',
  source: 'traders-curated',
  uri: null,
  license: 'CC0-1.0',
  sections: [{ id: 'chunk-1', ord: 1, heading: 'What it is', text: 'A fall from a high.' }],
};

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

const concept = vi.fn();
const searchConcepts = vi.fn();

function buildApp() {
  resetConfigForTests();
  return createApp(loadConfig(ENV), { concept, searchConcepts } as never);
}

async function loginCookie(app: ReturnType<typeof buildApp>): Promise<string> {
  const response = await app.request('/auth/login', {
    method: 'POST',
    headers: ORIGIN,
    body: JSON.stringify({ passphrase: 'test-passphrase' }),
  });
  return (response.headers.get('set-cookie') as string).split(';')[0]!;
}

describe('GET /concepts/:slug', () => {
  let app: ReturnType<typeof buildApp>;
  let cookie: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = buildApp();
    cookie = await loginCookie(app);
  });

  it('returns the explanation the AI service supplies', async () => {
    concept.mockResolvedValueOnce(DOCUMENT);

    const response = await app.request('/concepts/drawdown', { headers: { cookie } });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ title: 'Drawdown' });
    expect(concept).toHaveBeenCalledWith('drawdown', expect.anything());
  });

  it('reads a concept the corpus does not hold as absent, and says why', async () => {
    concept.mockRejectedValueOnce(new AiServiceError('not found', 404));

    const response = await app.request('/concepts/not-a-concept', { headers: { cookie } });

    expect(response.status).toBe(404);
    const body = (await response.json()) as { message: string };
    expect(body.message).toContain('not-a-concept');
    // The likely cause in a fresh environment, so the reader is not sent
    // looking for a fault that is really an unloaded fixture.
    expect(body.message).toContain('ingested');
  });

  it('does not disguise a real AI-service failure as a missing concept', async () => {
    concept.mockRejectedValueOnce(new AiServiceError('upstream exploded', 502));

    const response = await app.request('/concepts/drawdown', { headers: { cookie } });

    expect(response.status).toBe(502);
  });

  it('passes a timeout through as a timeout', async () => {
    concept.mockRejectedValueOnce(new AiServiceError('timed out', 504));

    const response = await app.request('/concepts/drawdown', { headers: { cookie } });

    expect(response.status).toBe(504);
  });

  it('does not forward an AI-service 401 as the reader\'s problem', async () => {
    // A 401 from the AI service means our own internal key is wrong. Passing it
    // through would tell the browser the session had expired and send the
    // reader to log in again over a server misconfiguration.
    concept.mockRejectedValueOnce(new AiServiceError('bad internal key', 401));

    const response = await app.request('/concepts/drawdown', { headers: { cookie } });

    expect(response.status).toBe(502);
  });

  it('reports an unreachable AI service as unavailable', async () => {
    concept.mockRejectedValueOnce(new AiServiceError('unreachable', 503));

    const response = await app.request('/concepts/drawdown', { headers: { cookie } });

    expect(response.status).toBe(503);
  });

  it('requires a session', async () => {
    const response = await app.request('/concepts/drawdown');

    expect(response.status).toBe(401);
    expect(concept).not.toHaveBeenCalled();
  });

  it('passes a slug through url-encoded rather than splitting on it', async () => {
    concept.mockResolvedValueOnce(DOCUMENT);

    await app.request('/concepts/peak-to-trough', { headers: { cookie } });

    expect(concept).toHaveBeenCalledWith('peak-to-trough', expect.anything());
  });
});

const SEARCH = {
  query: 'what is a drawdown',
  matches: [
    {
      chunk_id: 'chunk-1',
      document_id: 'doc-1',
      concept_slug: 'drawdown',
      title: 'Drawdown',
      heading: 'What it is',
      ord: 1,
      text: 'A fall from a peak to a trough.',
      score: 0.032,
      vector_rank: 1,
      text_rank: 2,
    },
  ],
  embedding_model: 'fixture/hashed-v1',
  vector_is_semantic: false,
};

describe('GET /concepts/search', () => {
  let app: ReturnType<typeof buildApp>;
  let cookie: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = buildApp();
    cookie = await loginCookie(app);
  });

  /**
   * The test worth having. Hono matches routes in registration order, so
   * `/concepts/:slug` declared first would swallow this as a request for a
   * concept called "search" - which answers 404 about a slug nobody asked for
   * and reads as an un-ingested corpus rather than as a shadowed route. It is
   * invisible in review and costs nothing to pin.
   */
  it('is not shadowed by the slug route', async () => {
    searchConcepts.mockResolvedValueOnce(SEARCH);

    const response = await app.request('/concepts/search?q=what+is+a+drawdown', {
      headers: { cookie },
    });

    expect(response.status).toBe(200);
    expect(concept).not.toHaveBeenCalled();
    expect(searchConcepts).toHaveBeenCalledWith('what is a drawdown', undefined, expect.anything());
  });

  it('carries the honesty flag through to the browser', async () => {
    // A ranking produced by word overlap is indistinguishable from one produced
    // by understanding the question. The reader is told which it was, which is
    // guideline 7 applied to retrieval rather than to figures.
    searchConcepts.mockResolvedValueOnce(SEARCH);

    const response = await app.request('/concepts/search?q=drawdown', { headers: { cookie } });

    await expect(response.json()).resolves.toMatchObject({
      vector_is_semantic: false,
      embedding_model: 'fixture/hashed-v1',
    });
  });

  it('refuses an empty query rather than returning arbitrary chunks', async () => {
    const response = await app.request('/concepts/search?q=%20%20', { headers: { cookie } });

    expect(response.status).toBe(400);
    expect(searchConcepts).not.toHaveBeenCalled();
  });

  it('refuses a missing query', async () => {
    const response = await app.request('/concepts/search', { headers: { cookie } });

    expect(response.status).toBe(400);
    expect(searchConcepts).not.toHaveBeenCalled();
  });

  it('bounds the limit at this edge rather than trusting the AI service', async () => {
    const response = await app.request('/concepts/search?q=drawdown&limit=500', {
      headers: { cookie },
    });

    expect(response.status).toBe(400);
    expect(searchConcepts).not.toHaveBeenCalled();
  });

  it('refuses a limit that is not a whole number', async () => {
    const response = await app.request('/concepts/search?q=drawdown&limit=2.5', {
      headers: { cookie },
    });

    expect(response.status).toBe(400);
  });

  it('passes a valid limit through', async () => {
    searchConcepts.mockResolvedValueOnce(SEARCH);

    await app.request('/concepts/search?q=drawdown&limit=3', { headers: { cookie } });

    expect(searchConcepts).toHaveBeenCalledWith('drawdown', 3, expect.anything());
  });

  it('reports an upstream failure as ours, not as an empty corpus', async () => {
    // Unlike the slug route there is no 404 case here: a search that matches
    // nothing is an empty list, not a missing document. So every AI-service
    // failure is an upstream fault, including a 404, which at this path could
    // only mean the endpoint itself is gone.
    searchConcepts.mockRejectedValueOnce(new AiServiceError('not found', 404));

    const response = await app.request('/concepts/search?q=drawdown', { headers: { cookie } });

    expect(response.status).toBe(502);
  });

  it('requires a session', async () => {
    const response = await app.request('/concepts/search?q=drawdown');

    expect(response.status).toBe(401);
    expect(searchConcepts).not.toHaveBeenCalled();
  });
});
