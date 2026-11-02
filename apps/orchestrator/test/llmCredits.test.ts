/**
 * The Admin page's balance (D44, D360): the installation's provider credit, in
 * this API's shape. The model pickers it once sat beside are gone - the admin
 * chooses like every user - and so is the route that wrote them.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LlmCreditsResponse } from '@traders/shared/ai';
import { ACTIVE_SESSION, sessionCookie } from './session.js';

const ADMIN = {
  ...ACTIVE_SESSION,
  id: '00000000-0000-0000-0000-000000000001',
  email: null,
  base_currency: 'USD',
  timezone: 'Asia/Jerusalem',
  role: 'admin',
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
  getUser: vi.fn(async () => ADMIN),
  insertAdminAudit: vi.fn(async () => undefined),
}));

const { loadConfig, resetConfigForTests } = await import('../src/config.js');
const { createApp } = await import('../src/http/app.js');
const { createFakeAi } = await import('./fakeAi.js');
const { AiServiceError } = await import('@traders/shared/ai');
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

const HEADERS = { origin: 'http://localhost:5173', 'content-type': 'application/json' };

let answer: LlmCreditsResponse;
let unavailable = false;

function buildApp() {
  resetConfigForTests();
  const ai = createFakeAi();
  Object.assign(ai, {
    async llmCredits() {
      if (unavailable) throw new AiServiceError('down', 503);
      return answer;
    },
  });
  return createApp(loadConfig(ENV), ai);
}

type App = ReturnType<typeof buildApp>;

describe('the balance', () => {
  let app: App;
  let cookie: string;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queries.getUser).mockResolvedValue(ADMIN as never);
    answer = {
      provider: 'openrouter',
      credits: { purchased_usd: '10', used_usd: '0.25', remaining_usd: '9.75' },
    };
    unavailable = false;
    app = buildApp();
    cookie = sessionCookie();
  });

  const get = (path: string) => app.request(path, { headers: { ...HEADERS, cookie } });

  it("says the provider's balance", async () => {
    const response = await get('/admin/llm/credits');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      provider: 'openrouter',
      credits: { purchasedUsd: '10', usedUsd: '0.25', remainingUsd: '9.75' },
    });
  });

  it('says nothing rather than a zero when the provider reports no balance', async () => {
    answer = { provider: 'ollama', credits: null };
    expect(await (await get('/admin/llm/credits')).json()).toEqual({ provider: 'ollama', credits: null });
  });

  it('no longer lists or writes an installation-wide model choice', async () => {
    expect((await get('/admin/llm/models')).status).toBe(404);
    const put = await app.request('/admin/llm/models/agent', {
      method: 'PUT',
      headers: { ...HEADERS, cookie },
      body: JSON.stringify({ model: 'anthropic/claude-sonnet-5.5' }),
    });
    expect(put.status).toBe(404);
  });

  it('says the AI service could not answer rather than failing', async () => {
    unavailable = true;
    const response = await get('/admin/llm/credits');
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect((await response.json()).error).not.toBe('internal_error');
  });
});
