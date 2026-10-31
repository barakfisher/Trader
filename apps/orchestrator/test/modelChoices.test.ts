/**
 * A user's own model choice (D244, D283-D284): the list is the AI service's,
 * only a listed model (or none) may be saved, the admin is refused, and an
 * agent's model is the agent's owner's to set.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LlmListedModelsResponse, UserLlmModelsResponse } from '@traders/shared/ai';
import { ACTIVE_SESSION, sessionCookie, TEST_USER_ID } from './session.js';

const USER = {
  ...ACTIVE_SESSION,
  id: TEST_USER_ID,
  email: 'user@example.test',
  base_currency: 'USD',
  timezone: 'Asia/Jerusalem',
  role: 'user',
};
const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_PICK = 'anthropic/claude-sonnet-5.5';
const LISTED_MODEL = 'acme/model-1';
const FALLBACK_MODEL = 'google/gemini-3.5-flash-lite';

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
  getUser: vi.fn(async () => USER),
  getAgent: vi.fn(async () => ({ id: AGENT_ID, is_primary: false })),
  setAgentModel: vi.fn(async () => true),
  setUserModel: vi.fn(async () => undefined),
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

let listed: LlmListedModelsResponse;
let user: UserLlmModelsResponse;
let unavailable = false;

function list(): LlmListedModelsResponse {
  return {
    choosable: true,
    live: true,
    fallback_model: FALLBACK_MODEL,
    models: [
      {
        id: FALLBACK_MODEL,
        name: 'Google: Gemini 3.5 Flash-Lite',
        prompt_usd_per_mtok: '0.3',
        completion_usd_per_mtok: '2.5',
        tested: true,
        scan_estimate_micro_usd: 900,
      },
      {
        id: LISTED_MODEL,
        name: 'Acme: Model 1',
        prompt_usd_per_mtok: '1',
        completion_usd_per_mtok: '4',
        tested: false,
        scan_estimate_micro_usd: 3000,
      },
    ],
  };
}

function resolutions(): UserLlmModelsResponse {
  return {
    admin: false,
    choosable: true,
    live: true,
    agent_default: FALLBACK_MODEL,
    choices: [
      { scope: 'explain', saved: null, effective: FALLBACK_MODEL, fallback: false },
      { scope: 'assistant', saved: 'acme/retired', effective: FALLBACK_MODEL, fallback: true },
    ],
    agents: [{ agent_id: AGENT_ID, name: 'Tech Agent', saved: LISTED_MODEL, effective: LISTED_MODEL, fallback: false }],
  };
}

function buildApp() {
  resetConfigForTests();
  const ai = createFakeAi();
  Object.assign(ai, {
    async llmListed() {
      if (unavailable) throw new AiServiceError('down', 503);
      return listed;
    },
    async userLlmModels() {
      return user;
    },
  });
  return createApp(loadConfig(ENV), ai);
}

describe('a user choosing their models', () => {
  let app: ReturnType<typeof buildApp>;
  let cookie: string;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queries.getUser).mockResolvedValue(USER as never);
    listed = list();
    user = resolutions();
    unavailable = false;
    app = buildApp();
    cookie = sessionCookie();
  });

  const put = (path: string, body: unknown) =>
    app.request(path, { method: 'PUT', headers: { ...HEADERS, cookie }, body: JSON.stringify(body) });

  it('reads the list, the tested mark and each resolution, fallbacks included', async () => {
    const response = await app.request('/settings/llm-models', { headers: { ...HEADERS, cookie } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.fallbackModel).toBe(FALLBACK_MODEL);
    expect(body.models.map((model: { id: string; tested: boolean }) => [model.id, model.tested])).toEqual([
      [FALLBACK_MODEL, true],
      [LISTED_MODEL, false],
    ]);
    expect(body.choices.assistant).toEqual({ saved: 'acme/retired', effective: FALLBACK_MODEL, fallback: true });
    expect(body.agents).toEqual([
      { agentId: AGENT_ID, name: 'Tech Agent', saved: LISTED_MODEL, effective: LISTED_MODEL, fallback: false },
    ]);
  });

  it('saves a listed model for Ask, and clears it with null', async () => {
    expect((await put('/settings/llm-models/assistant', { model: LISTED_MODEL })).status).toBe(200);
    expect(queries.setUserModel).toHaveBeenCalledWith(TEST_USER_ID, 'assistant', LISTED_MODEL);
    expect((await put('/settings/llm-models/explain', { model: null })).status).toBe(200);
    expect(queries.setUserModel).toHaveBeenLastCalledWith(TEST_USER_ID, 'explain', null);
  });

  it('refuses a model that is not listed, an unknown scope and a malformed body', async () => {
    const unlisted = await put('/settings/llm-models/assistant', { model: 'acme/retired' });
    expect(unlisted.status).toBe(422);
    expect((await unlisted.json()).error).toBe('model_not_offered');
    expect((await put('/settings/llm-models/agent', { model: LISTED_MODEL })).status).toBe(404);
    expect((await put('/settings/llm-models/assistant', { model: 7 })).status).toBe(400);
    expect(queries.setUserModel).not.toHaveBeenCalled();
  });

  it('refuses every choice where nothing can be chosen', async () => {
    listed = { ...list(), choosable: false };
    const response = await put('/settings/llm-models/assistant', { model: LISTED_MODEL });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe('models_not_choosable');
  });

  it("says so when the AI service can't give the list, and saves nothing", async () => {
    unavailable = true;
    expect((await put('/settings/llm-models/assistant', { model: LISTED_MODEL })).status).toBe(503);
    expect(queries.setUserModel).not.toHaveBeenCalled();
  });

  it("sets an agent's model, never the main portfolio's", async () => {
    expect((await put(`/agents/${AGENT_ID}/model`, { model: LISTED_MODEL })).status).toBe(200);
    expect(queries.setAgentModel).toHaveBeenCalledWith(TEST_USER_ID, AGENT_ID, LISTED_MODEL);

    vi.mocked(queries.getAgent).mockResolvedValueOnce({ id: AGENT_ID, is_primary: true } as never);
    expect((await put(`/agents/${AGENT_ID}/model`, { model: LISTED_MODEL })).status).toBe(409);

    vi.mocked(queries.getAgent).mockResolvedValueOnce(null);
    expect((await put(`/agents/${AGENT_ID}/model`, { model: LISTED_MODEL })).status).toBe(404);
  });

  it("refuses the admin Ask's and the explanations' model, which are the Admin page's", async () => {
    vi.mocked(queries.getUser).mockResolvedValue({ ...USER, role: 'admin' } as never);
    expect((await put('/settings/llm-models/assistant', { model: LISTED_MODEL })).status).toBe(403);
    expect(queries.setUserModel).not.toHaveBeenCalled();
  });

  it("lets the admin choose an agent's model from the same list (D352)", async () => {
    vi.mocked(queries.getUser).mockResolvedValue({ ...USER, role: 'admin' } as never);
    vi.mocked(queries.getAgent).mockResolvedValueOnce({ id: AGENT_ID, is_primary: false } as never);
    vi.mocked(queries.setAgentModel).mockResolvedValueOnce(true);
    user = { ...resolutions(), admin: true, agent_default: ADMIN_PICK };
    const response = await put(`/agents/${AGENT_ID}/model`, { model: LISTED_MODEL });
    expect(response.status).toBe(200);
    expect(queries.setAgentModel).toHaveBeenCalledWith(TEST_USER_ID, AGENT_ID, LISTED_MODEL);
    const body = await response.json();
    expect(body.admin).toBe(true);
    expect(body.agentDefault).toBe(ADMIN_PICK);
    expect(body.models.map((model: { id: string }) => model.id)).toEqual([FALLBACK_MODEL, LISTED_MODEL]);
  });
});
