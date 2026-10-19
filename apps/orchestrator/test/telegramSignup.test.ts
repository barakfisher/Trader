/**
 * The admin's sign-up request message in Telegram (D156, D184, D187, D188):
 * its signed buttons, the preset amounts behind *Custom budget*, the decision
 * each tap applies, and a stale message healing. No bot token, no network.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LLM_CAP_CEILING_MICRO_USD } from '@traders/shared';

const ADMIN = '00000000-0000-0000-0000-000000000001';
const REQUESTER = '11111111-1111-4111-8111-111111111111';
const CHAT = 987654321;
const WEBHOOK_SECRET = 'a-webhook-secret-long-enough';
const SIGNING_SECRET = 'a-signing-secret-long-enough';

let admin = true;
let requestStatus = 'pending';

vi.mock('../src/db/pool.js', () => ({
  queryOne: vi.fn(async () => null),
  query: vi.fn(async () => []),
  transaction: vi.fn(),
  initPool: vi.fn(),
  getPool: vi.fn(),
  closePool: vi.fn(),
}));

vi.mock('../src/db/queries.js', () => ({
  findTelegramBindingByChat: vi.fn(async () => ({ user_id: ADMIN, chat_id: String(CHAT), username: null, bound_at: new Date() })),
  getUser: vi.fn(async () => ({ id: ADMIN, timezone: 'Asia/Jerusalem' })),
  getOrCreateUserSettings: vi.fn(async () => ({ language: 'en' })),
  isActiveAdmin: vi.fn(async () => admin),
  getSignupRequest: vi.fn(async () => ({
    user_id: REQUESTER,
    email: 'noa@example.com',
    timezone: 'Europe/London',
    status: requestStatus,
    created_at: new Date(),
  })),
  getInstallationSettings: vi.fn(async () => ({ default_llm_cap_micro_usd: 10_000_000 })),
  listAdminChats: vi.fn(async () => [{ user_id: ADMIN, chat_id: String(CHAT), language: 'en' }]),
  approveSignup: vi.fn(async () => ({ applied: true, status: 'active', email: 'noa@example.com' })),
  rejectSignup: vi.fn(async () => ({ applied: true, status: 'rejected', email: 'noa@example.com' })),
  insertAdminAudit: vi.fn(async () => undefined),
  findProposal: vi.fn(async () => null),
}));

const { loadConfig, resetConfigForTests } = await import('../src/config.js');
const { createApp } = await import('../src/http/app.js');
const { createFakeAi } = await import('./fakeAi.js');
const { TelegramNotifier } = await import('../src/telegram/client.js');
const { MAX_CALLBACK_DATA_BYTES, decodeCallbackData } = await import('../src/telegram/callbackToken.js');
const { decodeSignupData, encodeSignupData } = await import('../src/telegram/signupToken.js');
const { announceSignupRequest, PRESET_CAPS_MICRO_USD } = await import('../src/telegram/signupApproval.js');
const queries = await import('../src/db/queries.js');

const ENV = {
  APP_ENV: 'test',
  LOG_LEVEL: 'error',
  SESSION_SECRET: 'test-session-secret-value',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  AI_SERVICE_URL: 'http://ai-service:8000',
  INTERNAL_API_KEY: 'internal-test-key',
  ALLOWED_ORIGINS: 'http://localhost:5173',
  TELEGRAM_BOT_TOKEN: 'bot-token',
  TELEGRAM_BOT_USERNAME: 'traders_test_bot',
  TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
  TELEGRAM_SIGNING_SECRET: SIGNING_SECRET,
} as unknown as NodeJS.ProcessEnv;

let calls: { method: string; body: Record<string, unknown> }[] = [];
let notifier: InstanceType<typeof TelegramNotifier>;

function buildNotifier(webBaseUrl: string | null = 'https://traders.example.ts.net') {
  return new TelegramNotifier({
    botToken: 'bot-token',
    callbackSecret: SIGNING_SECRET,
    resolveChatId: async () => String(CHAT),
    webBaseUrl,
    fetchImpl: async (url, init) => {
      calls.push({ method: url.split('/').pop() as string, body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response('{"ok":true}', { status: 200 });
    },
  });
}

let app: ReturnType<typeof createApp>;

function build(webBaseUrl?: string | null) {
  resetConfigForTests();
  calls = [];
  notifier = buildNotifier(webBaseUrl);
  app = createApp(loadConfig(ENV), createFakeAi(), notifier);
}

const REQUEST_TEXT = 'New sign-up request\n\nnoa@example.com';

const tap = (data: string) =>
  app.request('/telegram/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
    body: JSON.stringify({
      callback_query: { id: 'cb-1', data, message: { message_id: 7, text: REQUEST_TEXT, chat: { id: CHAT } } },
    }),
  });

type Button = { text: string; callback_data?: string; url?: string };
const buttonsOf = (call: { body: Record<string, unknown> }) =>
  (call.body.reply_markup as { inline_keyboard: Button[][] }).inline_keyboard.flat();
const toast = () => String(calls.find((call) => call.method === 'answerCallbackQuery')?.body.text);
const last = (method: string) => calls.filter((call) => call.method === method).at(-1)!;

describe('the sign-up button token', () => {
  it('round-trips each action, a $0 cap and the ceiling, inside 64 bytes', () => {
    for (const payload of [
      { userId: REQUESTER, action: 'approve', capMicroUsd: 0 },
      { userId: REQUESTER, action: 'approve', capMicroUsd: LLM_CAP_CEILING_MICRO_USD },
      { userId: REQUESTER, action: 'reject' },
      { userId: REQUESTER, action: 'custom' },
    ] as const) {
      const data = encodeSignupData(payload, SIGNING_SECRET);
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(MAX_CALLBACK_DATA_BYTES);
      expect(decodeSignupData(data, SIGNING_SECRET)).toEqual(payload);
    }
  });

  it('is not a proposal button, and an edited cap or another secret fails', () => {
    const data = encodeSignupData({ userId: REQUESTER, action: 'approve', capMicroUsd: 5_000_000 }, SIGNING_SECRET);
    expect(decodeCallbackData(data, SIGNING_SECRET)).toBeNull();
    expect(decodeSignupData(data, 'another-secret-long-enough')).toBeNull();
    const edited = encodeSignupData({ userId: REQUESTER, action: 'approve', capMicroUsd: 50_000_000 }, SIGNING_SECRET);
    expect(decodeSignupData(`${edited.split('.')[0]}.${data.split('.')[1]}`, SIGNING_SECRET)).toBeNull();
  });

  it('refuses a cap past the ceiling rather than sending it', () => {
    expect(() =>
      encodeSignupData({ userId: REQUESTER, action: 'approve', capMicroUsd: LLM_CAP_CEILING_MICRO_USD + 1 }, SIGNING_SECRET),
    ).toThrow();
  });
});

describe('announcing a request', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requestStatus = 'pending';
    build();
  });

  it("messages the admin's chat with the default cap, Custom budget and Reject", async () => {
    await announceSignupRequest({ notifier, signingSecret: SIGNING_SECRET }, REQUESTER);
    const sent = last('sendMessage');
    expect(sent.body.chat_id).toBe(String(CHAT));
    expect(String(sent.body.text)).toContain('noa@example.com');
    expect(String(sent.body.text)).toContain('Europe/London');
    const buttons = buttonsOf(sent);
    expect(buttons.map((button) => button.text)).toEqual(['Approve, $10/month', 'Custom budget', 'Reject']);
    expect(decodeSignupData(buttons[0]!.callback_data!, SIGNING_SECRET)).toEqual({
      userId: REQUESTER,
      action: 'approve',
      capMicroUsd: 10_000_000,
    });
  });

  it('says nothing about a request that is no longer waiting', async () => {
    requestStatus = 'rejected';
    await announceSignupRequest({ notifier, signingSecret: SIGNING_SECRET }, REQUESTER);
    expect(calls).toEqual([]);
  });
});

describe('a tap on a request', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    admin = true;
    requestStatus = 'pending';
    build();
  });

  it('Custom budget offers the presets, a link for any other amount, and Reject', async () => {
    await tap(encodeSignupData({ userId: REQUESTER, action: 'custom' }, SIGNING_SECRET));
    const buttons = buttonsOf(last('editMessageReplyMarkup'));
    expect(buttons.map((button) => button.text)).toEqual(['$5/month', '$20/month', '$50/month', 'Other amount', 'Reject']);
    expect(buttons.slice(0, 3).map((button) => decodeSignupData(button.callback_data!, SIGNING_SECRET))).toEqual(
      PRESET_CAPS_MICRO_USD.map((cap) => ({ userId: REQUESTER, action: 'approve', capMicroUsd: cap })),
    );
    expect(buttons[3]!.url).toBe('https://traders.example.ts.net/admin');
    expect(queries.approveSignup).not.toHaveBeenCalled();
  });

  it('without a link to the app, says where any other amount is set', async () => {
    build(null);
    await tap(encodeSignupData({ userId: REQUESTER, action: 'custom' }, SIGNING_SECRET));
    expect(toast()).toContain('Admin page');
    expect(buttonsOf(last('editMessageReplyMarkup')).map((button) => button.text)).not.toContain('Other amount');
  });

  it('approves at the amount the button carried, audits it first, and reminds the admin to tell them', async () => {
    await tap(encodeSignupData({ userId: REQUESTER, action: 'approve', capMicroUsd: 20_000_000 }, SIGNING_SECRET));
    expect(queries.approveSignup).toHaveBeenCalledWith(REQUESTER, 20_000_000, ADMIN);
    expect(vi.mocked(queries.insertAdminAudit).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(queries.approveSignup).mock.invocationCallOrder[0]!,
    );
    expect(toast()).toBe('Approved.');
    const edit = last('editMessageText');
    expect(String(edit.body.text)).toMatch(/^New sign-up request[\s\S]*✅ Approved with \$20\/month \(\d\d:\d\d\)\. Let them know they can sign in\.$/);
    expect(buttonsOf(edit)).toEqual([]);
  });

  it('heals a message already decided on the page: says where it is, and drops the buttons', async () => {
    vi.mocked(queries.rejectSignup).mockResolvedValueOnce({ applied: false, status: 'active', email: 'noa@example.com' });
    await tap(encodeSignupData({ userId: REQUESTER, action: 'reject' }, SIGNING_SECRET));
    expect(toast()).toBe('Already approved.');
    expect(buttonsOf(last('editMessageReplyMarkup'))).toEqual([]);
    expect(calls.some((call) => call.method === 'editMessageText')).toBe(false);
  });

  it("refuses a forwarded request in a chat that is not an admin's", async () => {
    admin = false;
    await tap(encodeSignupData({ userId: REQUESTER, action: 'approve', capMicroUsd: 5_000_000 }, SIGNING_SECRET));
    expect(queries.approveSignup).not.toHaveBeenCalled();
    expect(queries.insertAdminAudit).not.toHaveBeenCalled();
  });
});
