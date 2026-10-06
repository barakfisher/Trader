/**
 * The Admin page's model pickers (D43, D44): what the AI service offers is what
 * may be chosen, a choice is written for its scope only, and an agent gets only
 * a billed model that calls tools.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LlmModelsResponse } from '@traders/shared/ai';

const ADMIN = {
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
  getUser: vi.fn(async () => ADMIN),
  insertAdminAudit: vi.fn(async () => undefined),
  chooseLlmModel: vi.fn(async () => undefined),
}));

const { loadConfig, resetConfigForTests } = await import('../src/config.js');
const { createApp } = await import('../src/http/app.js');
const { createFakeAi } = await import('./fakeAi.js');
const { AiServiceError } = await import('@traders/shared/ai');
const queries = await import('../src/db/queries.js');

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

const HEADERS = { origin: 'http://localhost:5173', 'content-type': 'application/json' };

const estimate = { daily_micro_usd: 20_000, monthly_micro_usd: 600_000 };

function catalogue(overrides: Partial<LlmModelsResponse> = {}): LlmModelsResponse {
  return {
    provider: 'openrouter',
    choosable: true,
    configured_model: 'nvidia/nemotron-3.5-lightning:free',
    choices: [
      { scope: 'explain', chosen: null, effective: 'nvidia/nemotron-3.5-lightning:free' },
      { scope: 'agent', chosen: null, effective: 'nvidia/nemotron-3.5-lightning:free' },
    ],
    models: [
      {
        id: 'anthropic/claude-sonnet-5.5',
        label: 'Claude Sonnet 5.5',
        prompt_usd_per_mtok: '2',
        completion_usd_per_mtok: '10',
        supports_tools: true,
        free: false,
        scopes: ['explain', 'agent'],
        explain_estimate: estimate,
        agent_estimate: estimate,
        scan_estimate_micro_usd: 110_000,
      },
      {
        id: 'nvidia/nemotron-3.5-lightning:free',
        label: 'Nemotron 3.5 Lightning (free)',
        prompt_usd_per_mtok: '0',
        completion_usd_per_mtok: '0',
        supports_tools: true,
        free: true,
        scopes: ['explain'],
        explain_estimate: { daily_micro_usd: 0, monthly_micro_usd: 0 },
        agent_estimate: null,
        scan_estimate_micro_usd: null,
      },
    ],
    explain_basis: { window_days: 7, prompt_tokens_per_day: 5000, completion_tokens_per_day: 900 },
    agent_basis: {
      scanning_agents: 1,
      scans_per_day: 1,
      prompt_tokens_per_scan: 45_000,
      completion_tokens_per_scan: 2_000,
      source: 'assumed',
    },
    credits: { purchased_usd: '10', used_usd: '0.25', remaining_usd: '9.75' },
    ...overrides,
  };
}

let listed: LlmModelsResponse;
let unavailable = false;

function buildApp() {
  resetConfigForTests();
  const ai = createFakeAi();
  Object.assign(ai, {
    async llmModels() {
      if (unavailable) throw new AiServiceError('down', 503);
      return listed;
    },
  });
  return createApp(loadConfig(ENV), ai);
}

type App = ReturnType<typeof buildApp>;

async function sessionCookie(app: App): Promise<string> {
  const response = await app.request('/auth/login', {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ passphrase: 'test-passphrase' }),
  });
  return (response.headers.get('set-cookie') as string).split(';')[0]!;
}

describe('the model pickers', () => {
  let app: App;
  let cookie: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(queries.getUser).mockResolvedValue(ADMIN as never);
    listed = catalogue();
    unavailable = false;
    app = buildApp();
    cookie = await sessionCookie(app);
  });

  const choose = (scope: string, body: unknown) =>
    app.request(`/admin/llm/models/${scope}`, {
      method: 'PUT',
      headers: { ...HEADERS, cookie },
      body: JSON.stringify(body),
    });

  it('lists the offered models with their estimates and the balance', async () => {
    const response = await app.request('/admin/llm/models', { headers: { ...HEADERS, cookie } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.models[0]).toMatchObject({
      id: 'anthropic/claude-sonnet-5.5',
      scopes: ['explain', 'agent'],
      estimates: { explain: { dailyMicroUsd: 20_000, monthlyMicroUsd: 600_000 } },
      scanEstimateMicroUsd: 110_000,
    });
    expect(body.credits).toEqual({ purchasedUsd: '10', usedUsd: '0.25', remainingUsd: '9.75' });
    expect(body.agentBasis.source).toBe('assumed');
  });

  it('writes an offered model for its scope, audited first, and answers the page afresh', async () => {
    const response = await choose('agent', { model: 'anthropic/claude-sonnet-5.5' });
    expect(response.status).toBe(200);
    expect(queries.chooseLlmModel).toHaveBeenCalledWith('agent', 'anthropic/claude-sonnet-5.5', ADMIN.id);
    expect(queries.insertAdminAudit).toHaveBeenCalledTimes(1);
    expect((await response.json()).choices).toHaveLength(2);
  });

  it('refuses a model the service does not offer', async () => {
    const response = await choose('explain', { model: 'some/unpriced-model' });
    expect(response.status).toBe(422);
    expect((await response.json()).error).toBe('model_not_offered');
    expect(queries.chooseLlmModel).not.toHaveBeenCalled();
  });

  it('refuses a free route for agents but allows it for explanations', async () => {
    const refused = await choose('agent', { model: 'nvidia/nemotron-3.5-lightning:free' });
    expect(refused.status).toBe(422);
    expect((await refused.json()).error).toBe('model_not_offered_for_scope');
    expect((await choose('explain', { model: 'nvidia/nemotron-3.5-lightning:free' })).status).toBe(200);
  });

  it('refuses any choice when the provider is not OpenRouter', async () => {
    listed = catalogue({ provider: 'ollama', choosable: false });
    const response = await choose('explain', { model: 'anthropic/claude-sonnet-5.5' });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe('models_not_choosable');
  });

  it('refuses an unknown scope and a malformed body', async () => {
    expect((await choose('narration', { model: 'anthropic/claude-sonnet-5.5' })).status).toBe(400);
    expect((await choose('explain', { model: '' })).status).toBe(400);
    expect((await choose('explain', { model: 'x', extra: 1 })).status).toBe(400);
  });

  it('says the AI service could not answer rather than failing', async () => {
    unavailable = true;
    const response = await app.request('/admin/llm/models', { headers: { ...HEADERS, cookie } });
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect((await response.json()).error).not.toBe('internal_error');
  });
});
