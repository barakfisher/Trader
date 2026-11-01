/**
 * The admin's sign-up request message in Telegram (D156, D187, D188, D279):
 * its signed buttons - Approve and Reject, no amount since users run on their
 * own key (D245) - the decision each tap applies, an old *Custom budget* button,
 * and a stale message healing. No bot token, no network.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LLM_CAP_CEILING_MICRO_USD } from '@traders/shared';

const ADMIN = '00000000-0000-0000-0000-000000000001';
const REQUESTER = '11111111-1111-4111-8111-111111111111';
const CHAT = 987654321;
const WEBHOOK_SECRET = 'a-webhook-secret-long-enough';
const SIGNING_SECRET = 'a-signing-secret-long-enough';
/** The retired monthly cap the approval writes to satisfy its column (D279). */
const RETIRED_CAP = 10_000_000;

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
  findTelegramBindingByChat: vi.fn(async () => ({ user_id: ADMIN, chat_id: String(CHAT), username: null, bound_at: new Date(), legal_accepted: true })),
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
  getInstallationSettings: vi.fn(async () => ({ default_llm_cap_micro_usd: RETIRED_CAP })),
  listAdminChats: vi.fn(async () => [{ user_id: ADMIN, chat_id: String(CHAT), language: 'en' }]),
  approveSignup: vi.fn(async () => ({ applied: true, status: 'active', email: 'noa@example.com' })),
  rejectSignup: vi.fn(async () => ({ applied: true, status: 'rejected', email: 'noa@example.com' })),
  insertAdminAudit: vi.fn(async () => undefined),
  findProposal: vi.fn(async () => null),
}));

const { loadConfig, resetConfigForTests } = await import('../src/config.js');
const { createApp } = await import('../src/http/app.js');
const { createFakeAi } = await import('./fakeAi.js');
const { memoryRateLimits } = await import('../src/http/rateLimits.js');
const { RecordingEmailSender } = await import('./recordingEmailSender.js');
const { TelegramNotifier } = await import('../src/telegram/client.js');
const { MAX_CALLBACK_DATA_BYTES, decodeCallbackData } = await import('../src/telegram/callbackToken.js');
const { decodeSignupData, encodeSignupData } = await import('../src/telegram/signupToken.js');
const { announceSignupRequest } = await import('../src/telegram/signupApproval.js');
const { messagesFor } = await import('../src/notify/messages.js');
const en = messagesFor('en');
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
let mail = new RecordingEmailSender();

function build(webBaseUrl?: string | null) {
  resetConfigForTests();
  calls = [];
  notifier = buildNotifier(webBaseUrl);
  mail = new RecordingEmailSender();
  app = createApp(loadConfig(ENV), createFakeAi(), notifier, null, memoryRateLimits(), mail);
}

const REQUEST_TEXT = 'New sign-up request\n\nnoa@example.com';

const tap = (data: string) =>
  app.request('/telegram/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
    body: JSON.stringify({
      callback_query: { id: 'cb-1', data, message: { message_id: 7, text: REQUEST_TEXT, chat: { id: CHAT, type: 'private' } } },
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

  it("messages the admin's chat with Approve and Reject, and no amount", async () => {
    await announceSignupRequest({ notifier, signingSecret: SIGNING_SECRET }, REQUESTER);
    const sent = last('sendMessage');
    expect(sent.body.chat_id).toBe(String(CHAT));
    expect(String(sent.body.text)).toContain('noa@example.com');
    expect(String(sent.body.text)).toContain('Europe/London');
    const buttons = buttonsOf(sent);
    expect(buttons.map((button) => button.text)).toEqual([en.signup.buttons.approve, en.signup.buttons.reject]);
    expect(decodeSignupData(buttons[0]!.callback_data!, SIGNING_SECRET)).toEqual({
      userId: REQUESTER,
      action: 'approve',
      capMicroUsd: RETIRED_CAP,
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

  it('an old Custom budget button shows Approve and Reject again, and decides nothing', async () => {
    await tap(encodeSignupData({ userId: REQUESTER, action: 'custom' }, SIGNING_SECRET));
    const buttons = buttonsOf(last('editMessageReplyMarkup'));
    expect(buttons.map((button) => button.text)).toEqual([en.signup.buttons.approve, en.signup.buttons.reject]);
    expect(queries.approveSignup).not.toHaveBeenCalled();
  });

  it('approves with the figure the button carried, audits it first, and reminds the admin to tell them', async () => {
    await tap(encodeSignupData({ userId: REQUESTER, action: 'approve', capMicroUsd: 20_000_000 }, SIGNING_SECRET));
    expect(queries.approveSignup).toHaveBeenCalledWith(REQUESTER, 20_000_000, ADMIN);
    expect(vi.mocked(queries.insertAdminAudit).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(queries.approveSignup).mock.invocationCallOrder[0]!,
    );
    expect(toast()).toBe('Approved.');
    const edit = last('editMessageText');
    expect(String(edit.body.text)).toMatch(/^New sign-up request[\s\S]*✅ Approved \(\d\d:\d\d\)\./);
    expect(String(edit.body.text)).not.toContain('/month');
    expect(buttonsOf(edit)).toEqual([]);
  });

  it('mails the approved person once, with a link to sign in on the first allowed origin (D344)', async () => {
    await tap(encodeSignupData({ userId: REQUESTER, action: 'approve', capMicroUsd: 20_000_000 }, SIGNING_SECRET));
    await mail.settled();
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ to: 'noa@example.com', subject: 'Your TikLens account is ready' });
    expect(mail.sent[0]!.text).toContain('http://localhost:5173/');
    // A second tap finds the request decided: no second mail.
    vi.mocked(queries.approveSignup).mockResolvedValueOnce({ applied: false, status: 'active', email: 'noa@example.com' });
    await tap(encodeSignupData({ userId: REQUESTER, action: 'approve', capMicroUsd: 20_000_000 }, SIGNING_SECRET));
    await mail.settled();
    expect(mail.sent).toHaveLength(1);
  });

  it('mails nobody on a rejection (D344)', async () => {
    await tap(encodeSignupData({ userId: REQUESTER, action: 'reject' }, SIGNING_SECRET));
    await mail.settled();
    expect(queries.rejectSignup).toHaveBeenCalledWith(REQUESTER);
    expect(mail.sent).toEqual([]);
  });

  it('still approves, toasts and edits the message when the mail fails (D344)', async () => {
    mail.failWith = new Error('smtp down');
    await tap(encodeSignupData({ userId: REQUESTER, action: 'approve', capMicroUsd: 20_000_000 }, SIGNING_SECRET));
    await mail.settled();
    expect(queries.approveSignup).toHaveBeenCalledTimes(1);
    expect(toast()).toBe('Approved.');
    expect(calls.some((call) => call.method === 'editMessageText')).toBe(true);
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
    await mail.settled();
    expect(mail.sent).toEqual([]);
  });
});
