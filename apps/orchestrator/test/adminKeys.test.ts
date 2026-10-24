/**
 * The Admin page's Keys tab (D251, D288): status never values, the Telegram
 * token's row from this service, a test only for the admin, and nothing
 * credential-shaped in any error the page is shown.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { InstallationKeysResponse } from '@traders/shared/ai';
import { ACTIVE_SESSION, sessionCookie } from './session.js';

const ADMIN = {
  ...ACTIVE_SESSION,
  id: '00000000-0000-0000-0000-000000000001',
  email: null,
  base_currency: 'USD',
  timezone: 'Asia/Jerusalem',
  role: 'admin',
};
const TOKEN = '123456789:AAE-thisIsNotARealTokenButShapedLikeOne_x';

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
  lastTelegramFailure: vi.fn(async () => ({
    at: new Date('2026-10-23T10:00:00Z'),
    error: `transport error: request to https://api.telegram.org/bot${TOKEN}/sendMessage failed`,
  })),
}));

const { loadConfig, resetConfigForTests } = await import('../src/config.js');
const { createApp } = await import('../src/http/app.js');
const { createFakeAi } = await import('./fakeAi.js');
const { AiServiceError } = await import('@traders/shared/ai');
const queries = await import('../src/db/queries.js');
const { LAST_ERROR_MAX_CHARS, redact } = await import('../src/services/installationKeys.js');

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

const KEYS: InstallationKeysResponse = {
  keys: [
    {
      name: 'OPENROUTER_API_KEY',
      provider: 'OpenRouter',
      is_set: true,
      serves: ['llm'],
      unused: null,
      testable: true,
      last_error: { at: '2026-10-22T09:00:00Z', message: 'HTTP 429: rate limited' },
    },
    { name: 'POLYGON_API_KEY', provider: 'Polygon', is_set: false, serves: [], unused: 'no_adapter', testable: false, last_error: null },
  ],
};

const tested: string[] = [];

function buildApp(env = ENV) {
  resetConfigForTests();
  const ai = createFakeAi();
  Object.assign(ai, {
    async installationKeys() {
      return KEYS;
    },
    async testInstallationKey(name: string) {
      tested.push(name);
      if (name === 'POLYGON_API_KEY') {
        throw new AiServiceError('no test', 409, { detail: { code: 'key_not_testable', message: 'no free check' } });
      }
      return { ok: false, detail: 'HTTP 401: invalid key sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789', checked_at: '2026-10-23T12:00:00Z' };
    },
  });
  return createApp(loadConfig(env), ai);
}

describe('the Keys tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tested.length = 0;
    vi.mocked(queries.getUser).mockResolvedValue(ADMIN as never);
  });

  const get = (app: ReturnType<typeof buildApp>) =>
    app.request('/admin/keys', { headers: { ...HEADERS, cookie: sessionCookie() } });
  const test = (app: ReturnType<typeof buildApp>, name: string) =>
    app.request(`/admin/keys/${name}/test`, { method: 'POST', headers: { ...HEADERS, cookie: sessionCookie() } });

  it("lists the AI service's keys and the Telegram token's, and redacts the token from its last error", async () => {
    const response = await get(buildApp());
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(TOKEN);
    const body = JSON.parse(text);
    expect(body.keys.map((key: { name: string }) => key.name)).toEqual([
      'OPENROUTER_API_KEY',
      'POLYGON_API_KEY',
      'TELEGRAM_BOT_TOKEN',
    ]);
    expect(body.keys[2]).toMatchObject({ isSet: false, serves: [], testable: false });
    expect(body.keys[2].lastError.message).toContain('[redacted]');
  });

  it('relays a test, audits it, and masks the key if the provider echoed it', async () => {
    const response = await test(buildApp(), 'OPENROUTER_API_KEY');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.detail).toContain('401');
    expect(body.detail).not.toContain('sk-or-v1-');
    expect(tested).toEqual(['OPENROUTER_API_KEY']);
    expect(queries.insertAdminAudit).toHaveBeenCalledTimes(1);
  });

  it("says a key with no test is not testable, in the service's code", async () => {
    const response = await test(buildApp(), 'POLYGON_API_KEY');
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe('key_not_testable');
  });

  it("refuses to test Telegram's token when none is set, and a malformed name without asking anyone", async () => {
    expect((await test(buildApp(), 'TELEGRAM_BOT_TOKEN')).status).toBe(409);
    expect((await test(buildApp(), 'not-a-key')).status).toBe(404);
    expect(tested).toEqual([]);
  });

  it('is the admin\'s alone', async () => {
    vi.mocked(queries.getUser).mockResolvedValue({ ...ADMIN, role: 'user' } as never);
    expect((await get(buildApp())).status).toBe(403);
    expect((await test(buildApp(), 'OPENROUTER_API_KEY')).status).toBe(403);
    expect(tested).toEqual([]);
  });
});

describe('redact', () => {
  it('masks the shapes the review named, and the configured value word for word', () => {
    expect(redact(`token ${'123456789:AAH' + 'a'.repeat(32)}`)).not.toContain('AAH');
    expect(redact('Incorrect API key provided: sk-proj-****abcd')).not.toContain('proj-');
    expect(redact('GET /q?apikey=s3cr3t&s=1')).not.toContain('s3cr3t');
    expect(redact('bad key abcd1234efgh', 'abcd1234efgh')).not.toContain('abcd1234efgh');
  });

  it('masks credential shapes and bounds the length', () => {
    expect(redact(`bot${TOKEN}`)).not.toContain(TOKEN);
    expect(redact('Bearer abc.def')).toBe('[redacted]');
    expect(redact('x '.repeat(LAST_ERROR_MAX_CHARS))).toHaveLength(LAST_ERROR_MAX_CHARS);
  });
});
