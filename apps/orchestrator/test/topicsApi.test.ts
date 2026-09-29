/**
 * The proxy in front of topic resolution.
 *
 * The assertion worth having is that `verdict: 'unavailable'` arrives as a 200
 * with the universe's state intact. An installation with no universe loaded is
 * the normal state of a fresh clone, and the browser has to be able to tell it
 * apart from a topic that genuinely matches nothing - and from a broken AI
 * service, which keeps its gateway status.
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

const TOPIC_ID = '10000000-0000-0000-0000-000000000001';
const CREATED = new Date('2026-09-24T10:00:00Z');
const TOPIC_ROW = {
  id: TOPIC_ID,
  label: 'uranium',
  status: 'active',
  created_by: 'user',
  created_at: CREATED,
  updated_at: CREATED,
  confirmed_at: CREATED,
  instrument_count: 1,
  evidence: null,
};
const INSTRUMENT_ROW = {
  instrument_id: 'i-1',
  symbol: 'CCJ',
  name: 'Cameco',
  asset_class: 'equity',
  source: 'resolver',
  confidence: 'confident',
  rationale: 'Cameco mines uranium.',
  held_by: [{ etf: 'URA', weight: '0.2195' }],
  added_at: CREATED,
};

const queries = vi.hoisted(() => ({
  listTopics: vi.fn(),
  getTopic: vi.fn(),
  listTopicInstruments: vi.fn(),
  listTopicArticles: vi.fn(),
  listTopicSentimentRows: vi.fn(),
  deleteTopic: vi.fn(),
  rejectProposal: vi.fn(),
  getLatestFinishedRun: vi.fn(async (): Promise<unknown> => null),
}));

vi.mock('../src/db/queries.js', () => ({
  getUser: vi.fn(async () => USER),
  ...queries,
}));

const confirmTopic = vi.hoisted(() => vi.fn());
vi.mock('../src/services/topics.js', async (original) => ({
  ...(await original<typeof import('../src/services/topics.js')>()),
  confirmTopic,
}));

const {
  DEFAULT_PROPOSAL_TTL_DAYS,
  DEFAULT_REJECTION_COOLDOWN_DAYS,
  loadConfig,
  resetConfigForTests,
} = await import('../src/config.js');
const { MAX_OPEN_PROPOSALS, MAX_OPEN_WEAK_PROPOSALS } =
  await import('../src/services/topicDiscovery.js');
const { createApp } = await import('../src/http/app.js');
const {
  MAX_ACTIVE_TOPICS,
  MAX_INSTRUMENTS_PER_TOPIC,
  MAX_TOPIC_LABEL_LENGTH: MAX_TOPIC_LENGTH,
} = await import('../src/services/topics.js');
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

const UNAVAILABLE = {
  topic: 'uranium',
  verdict: 'unavailable',
  best_similarity: null,
  refuse_below: 0.32,
  confident_above: 0.45,
  interpretations: [],
  ambiguous: false,
  universe: { state: 'not_loaded', profiles: 0, embedded: 0 },
  embedding_model: 'fixture/hashed-v1',
  vector_is_semantic: false,
};

const resolveTopic = vi.fn();

function buildApp() {
  resetConfigForTests();
  return createApp(loadConfig(ENV), { resolveTopic } as never);
}

async function loginCookie(app: ReturnType<typeof buildApp>): Promise<string> {
  const response = await app.request('/auth/login', {
    method: 'POST',
    headers: ORIGIN,
    body: JSON.stringify({ passphrase: 'test-passphrase' }),
  });
  return (response.headers.get('set-cookie') as string).split(';')[0]!;
}

describe('POST /topics/resolve', () => {
  let app: ReturnType<typeof buildApp>;
  let cookie: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = buildApp();
    cookie = await loginCookie(app);
  });

  const post = (body: unknown, headers: Record<string, string> = { cookie }) =>
    app.request('/topics/resolve', {
      method: 'POST',
      headers: { ...ORIGIN, ...headers },
      body: JSON.stringify(body),
    });

  it('passes an unloaded universe through as a 200 with its state named', async () => {
    resolveTopic.mockResolvedValueOnce(UNAVAILABLE);

    const response = await post({ topic: 'uranium' });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      verdict: 'unavailable',
      universe: { state: 'not_loaded' },
    });
  });

  it('trims the topic before it reaches the AI service', async () => {
    resolveTopic.mockResolvedValueOnce(UNAVAILABLE);

    await post({ topic: '  uranium \n' });

    expect(resolveTopic).toHaveBeenCalledWith('uranium', expect.anything());
  });

  it.each([{}, { topic: '   ' }, { topic: 42 }, null])(
    'refuses %j before it reaches the AI service',
    async (body) => {
      const response = await post(body);

      expect(response.status).toBe(400);
      expect(resolveTopic).not.toHaveBeenCalled();
    },
  );

  it('refuses a topic longer than the AI service would accept', async () => {
    const response = await post({ topic: 'x'.repeat(MAX_TOPIC_LENGTH + 1) });

    expect(response.status).toBe(400);
    expect(resolveTopic).not.toHaveBeenCalled();
  });

  it.each([
    [401, 502],
    [422, 502],
    [503, 503],
    [504, 504],
  ])('translates an AI-service %i into %i, never forwarding it', async (upstream, ours) => {
    resolveTopic.mockRejectedValueOnce(new AiServiceError('upstream', upstream));

    const response = await post({ topic: 'uranium' });

    expect(response.status).toBe(ours);
  });

  it('requires a session', async () => {
    const response = await post({ topic: 'uranium' }, {});

    expect(response.status).toBe(401);
    expect(resolveTopic).not.toHaveBeenCalled();
  });
});

describe('topic CRUD', () => {
  let app: ReturnType<typeof buildApp>;
  let cookie: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = buildApp();
    cookie = await loginCookie(app);
  });

  const send = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { ...ORIGIN, cookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it('lists topics with the limits the UI has to show', async () => {
    queries.listTopics.mockResolvedValueOnce([TOPIC_ROW]);

    const response = await send('GET', '/topics');

    expect(response.status).toBe(200);
    const body = (await response.json()) as { topics: unknown[]; limits: Record<string, number> };
    expect(body.topics).toEqual([
      {
        id: TOPIC_ID,
        label: 'uranium',
        status: 'active',
        createdBy: 'user',
        createdAt: CREATED.toISOString(),
        updatedAt: CREATED.toISOString(),
        confirmedAt: CREATED.toISOString(),
        instrumentCount: 1,
        evidence: null,
      },
    ]);
    expect(body.limits).toEqual({
      maxActiveTopics: MAX_ACTIVE_TOPICS,
      maxInstrumentsPerTopic: MAX_INSTRUMENTS_PER_TOPIC,
      maxLabelLength: MAX_TOPIC_LENGTH,
      maxOpenProposals: MAX_OPEN_PROPOSALS,
      maxOpenWeakProposals: MAX_OPEN_WEAK_PROPOSALS,
      rejectionCooldownDays: DEFAULT_REJECTION_COOLDOWN_DAYS,
      proposalTtlDays: DEFAULT_PROPOSAL_TTL_DAYS,
    });
  });

  it('confirms a new topic with the normalised symbols, and answers 201 with its reasons', async () => {
    confirmTopic.mockResolvedValueOnce({
      ok: true,
      topic: TOPIC_ROW,
      instruments: [INSTRUMENT_ROW],
    });

    const response = await send('POST', '/topics', {
      label: '  uranium ',
      symbols: ['ccj', 'CCJ'],
    });

    expect(response.status).toBe(201);
    expect(confirmTopic).toHaveBeenCalledWith(
      expect.anything(),
      { userId: USER.id, topicId: null, label: 'uranium', symbols: ['CCJ'] },
      expect.anything(),
    );
    const body = (await response.json()) as { instruments: unknown[] };
    expect(body.instruments).toEqual([
      {
        instrumentId: 'i-1',
        symbol: 'CCJ',
        name: 'Cameco',
        assetClass: 'equity',
        source: 'resolver',
        confidence: 'confident',
        rationale: 'Cameco mines uranium.',
        heldBy: [{ etf: 'URA', weight: '0.2195' }],
        addedAt: CREATED.toISOString(),
      },
    ]);
  });

  it.each([
    [{ label: 'uranium' }, 400],
    [{ label: '  ', symbols: ['CCJ'] }, 400],
    [{ label: 'x'.repeat(MAX_TOPIC_LENGTH + 1), symbols: ['CCJ'] }, 400],
    [{ label: 'uranium', symbols: [' ', ''] }, 422],
    [
      {
        label: 'uranium',
        symbols: Array.from({ length: MAX_INSTRUMENTS_PER_TOPIC + 1 }, (_, i) => `S${i}`),
      },
      422,
    ],
  ])('refuses %j with %i before confirming anything', async (body, status) => {
    const response = await send('POST', '/topics', body);

    expect(response.status).toBe(status);
    expect(confirmTopic).not.toHaveBeenCalled();
  });

  it.each([
    [{ ok: false, reason: 'limit_reached', limit: 10 }, 422, 'topic_limit_reached'],
    [{ ok: false, reason: 'duplicate_label', label: 'uranium' }, 409, 'duplicate_topic'],
    [{ ok: false, reason: 'unresolved_symbols', symbols: ['NOPE'] }, 422, 'unresolved_symbols'],
    [{ ok: false, reason: 'not_found' }, 404, 'not_found'],
  ])('reports %j as %i %s', async (outcome, status, code) => {
    confirmTopic.mockResolvedValueOnce(outcome);

    const response = await send('POST', '/topics', { label: 'uranium', symbols: ['CCJ'] });

    expect(response.status).toBe(status);
    expect(((await response.json()) as { error: string }).error).toBe(code);
  });

  it('names the tickers no provider recognises, so the UI can mark them', async () => {
    confirmTopic.mockResolvedValueOnce({
      ok: false,
      reason: 'unresolved_symbols',
      symbols: ['NOPE'],
    });

    const response = await send('POST', '/topics', { label: 'uranium', symbols: ['NOPE'] });

    expect(((await response.json()) as { details: unknown }).details).toEqual({
      symbols: ['NOPE'],
    });
  });

  it('refuses a confirm when the resolver cannot be asked, instead of storing bare additions', async () => {
    confirmTopic.mockRejectedValueOnce(new AiServiceError('unreachable', 503));

    const response = await send('POST', '/topics', { label: 'uranium', symbols: ['CCJ'] });

    expect(response.status).toBe(503);
  });

  it('re-confirms an existing topic by id', async () => {
    confirmTopic.mockResolvedValueOnce({ ok: true, topic: TOPIC_ROW, instruments: [] });

    const response = await send('PUT', `/topics/${TOPIC_ID}`, {
      label: 'uranium',
      symbols: ['CCJ'],
    });

    expect(response.status).toBe(200);
    expect(confirmTopic.mock.calls[0]![1]).toMatchObject({ topicId: TOPIC_ID });
  });

  it('reads one topic with its instruments', async () => {
    queries.getTopic.mockResolvedValueOnce(TOPIC_ROW);
    queries.listTopicInstruments.mockResolvedValueOnce([INSTRUMENT_ROW]);

    const response = await send('GET', `/topics/${TOPIC_ID}`);

    expect(response.status).toBe(200);
    expect(queries.getTopic).toHaveBeenCalledWith(USER.id, TOPIC_ID);
    expect(((await response.json()) as { instruments: unknown[] }).instruments).toHaveLength(1);
  });

  it.each(['GET', 'PUT', 'DELETE'])(
    'answers %s on a malformed id with 404, never touching SQL',
    async (method) => {
      const body = method === 'PUT' ? { label: 'uranium', symbols: ['CCJ'] } : undefined;
      const response = await send(method, '/topics/not-a-uuid', body);

      expect(response.status).toBe(404);
      expect(queries.getTopic).not.toHaveBeenCalled();
      expect(queries.deleteTopic).not.toHaveBeenCalled();
      expect(confirmTopic).not.toHaveBeenCalled();
    },
  );

  it('answers a topic that is not the user’s with 404', async () => {
    queries.getTopic.mockResolvedValueOnce(null);

    expect((await send('GET', `/topics/${TOPIC_ID}`)).status).toBe(404);
  });

  it('deletes a topic, and 404s when there was nothing to delete', async () => {
    queries.deleteTopic.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    expect((await send('DELETE', `/topics/${TOPIC_ID}`)).status).toBe(204);
    expect((await send('DELETE', `/topics/${TOPIC_ID}`)).status).toBe(404);
    expect(queries.deleteTopic).toHaveBeenCalledWith(USER.id, TOPIC_ID);
  });

  it('refuses to delete a proposal, which would erase its rejection memory', async () => {
    queries.deleteTopic.mockResolvedValueOnce(false);
    queries.getTopic.mockResolvedValueOnce({
      ...TOPIC_ROW,
      status: 'proposed',
      created_by: 'auto',
    });

    const response = await send('DELETE', `/topics/${TOPIC_ID}`);

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe('topic_is_proposal');
  });

  it('rejects a proposal, and tells a followed topic from a missing one', async () => {
    queries.rejectProposal
      .mockResolvedValueOnce('rejected')
      .mockResolvedValueOnce('not_a_proposal')
      .mockResolvedValueOnce('not_found');

    expect((await send('POST', `/topics/${TOPIC_ID}/reject`)).status).toBe(204);
    expect(queries.rejectProposal).toHaveBeenCalledWith(USER.id, TOPIC_ID);
    expect((await send('POST', `/topics/${TOPIC_ID}/reject`)).status).toBe(409);
    expect((await send('POST', `/topics/${TOPIC_ID}/reject`)).status).toBe(404);
  });

  it('answers a reject for a malformed id with 404 without asking the database', async () => {
    expect((await send('POST', '/topics/not-a-uuid/reject')).status).toBe(404);
    expect(queries.rejectProposal).not.toHaveBeenCalled();
  });

  it('keeps the list behind the session gate', async () => {
    expect((await app.request('/topics')).status).toBe(401);
    expect(queries.listTopics).not.toHaveBeenCalled();
  });
});

describe('GET /topics/:id/news', () => {
  let app: ReturnType<typeof buildApp>;
  let cookie: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = buildApp();
    cookie = await loginCookie(app);
  });

  const get = (id = TOPIC_ID) => app.request(`/topics/${id}/news`, { headers: { cookie } });

  it('returns each article with the instrument and rule that tied it to the topic', async () => {
    queries.getTopic.mockResolvedValueOnce(TOPIC_ROW);
    queries.listTopicArticles.mockResolvedValueOnce([
      {
        id: 'a-1',
        url: 'https://example.com/cameco',
        source: 'Example Newswire',
        title: 'Cameco raises output',
        published_at: null,
        fetched_at: new Date('2026-09-26T08:00:00Z'),
        instruments: [
          {
            symbol: 'CCJ',
            match_method: 'company_name',
            matched_text: 'Cameco',
            salience: '0.8000',
          },
        ],
        sentiment: { score: '0.5000', magnitude: '0.2500', model: 'lexicon-v1' },
      },
    ]);

    const response = await get();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(queries.listTopicArticles).toHaveBeenCalledWith(USER.id, TOPIC_ID, body.days);
    expect(body.articles).toEqual([
      {
        id: 'a-1',
        url: 'https://example.com/cameco',
        source: 'Example Newswire',
        title: 'Cameco raises output',
        // An undated article stays undated; the fetch time is reported beside it.
        publishedAt: null,
        fetchedAt: '2026-09-26T08:00:00.000Z',
        instruments: [
          { symbol: 'CCJ', matchMethod: 'company_name', matchedText: 'Cameco', salience: '0.8000' },
        ],
        sentiment: { score: '0.5000', magnitude: '0.2500', model: 'lexicon-v1' },
      },
    ]);
  });

  it("is a 404 for a topic that is not the user's", async () => {
    queries.getTopic.mockResolvedValueOnce(null);
    expect((await get()).status).toBe(404);
    expect(queries.listTopicArticles).not.toHaveBeenCalled();
  });

  it('says which empty an empty list is: the last collection and who failed in it', async () => {
    queries.getTopic.mockResolvedValueOnce(TOPIC_ROW);
    queries.listTopicArticles.mockResolvedValueOnce([]);
    queries.getLatestFinishedRun.mockResolvedValueOnce({
      started_at: new Date('2026-09-27T14:01:12Z'),
      status: 'degraded',
      stats: { fetched: 0, provider_failures: ['gdelt'] },
    });

    const body = await (await get()).json();

    expect(queries.getLatestFinishedRun).toHaveBeenCalledWith(USER.id, 'news_collect');
    expect(body.articles).toEqual([]);
    expect(body.collection).toEqual({
      lastRunAt: '2026-09-27T14:01:12.000Z',
      status: 'degraded',
      failedProviders: ['gdelt'],
    });
  });

  it('reports no collection at all as null, not as a quiet week', async () => {
    queries.getTopic.mockResolvedValueOnce(TOPIC_ROW);
    queries.listTopicArticles.mockResolvedValueOnce([]);
    expect((await (await get()).json()).collection).toBeNull();
  });
});

describe('GET /topics/:id/sentiment', () => {
  let app: ReturnType<typeof buildApp>;
  let cookie: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = buildApp();
    cookie = await loginCookie(app);
  });

  const get = (query = '') =>
    app.request(`/topics/${TOPIC_ID}/sentiment${query}`, { headers: { cookie } });

  it("buckets days in the user's timezone and defaults to a week", async () => {
    queries.getTopic.mockResolvedValueOnce(TOPIC_ROW);
    queries.listTopicSentimentRows.mockResolvedValueOnce([]);

    const response = await get();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(queries.listTopicSentimentRows).toHaveBeenCalledWith(
      USER.id,
      TOPIC_ID,
      7,
      USER.timezone,
    );
    expect(body).toMatchObject({ days: 7, score: null, gap: 'no_articles' });
  });

  it.each(['0', '31', '2.5', 'week'])('refuses days=%s', async (days) => {
    expect((await get(`?days=${days}`)).status).toBe(400);
    expect(queries.listTopicSentimentRows).not.toHaveBeenCalled();
  });

  it("is a 404 for a topic that is not the user's", async () => {
    queries.getTopic.mockResolvedValueOnce(null);
    expect((await get()).status).toBe(404);
  });
});
