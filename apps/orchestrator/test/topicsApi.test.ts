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

vi.mock('../src/db/queries.js', () => ({
  getUser: vi.fn(async () => USER),
}));

const { loadConfig, resetConfigForTests } = await import('../src/config.js');
const { createApp } = await import('../src/http/app.js');
const { MAX_TOPIC_LENGTH } = await import('../src/http/routes/topics.js');
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
