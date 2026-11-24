/**
 * Approving a trade for the open from Telegram (D398): a trade raised while its
 * market is closed carries *Approve at the open*, a tap queues it and offers
 * *Cancel approval*, a cancel brings the first button back, and a tap after the
 * open is answered as Approve.
 *
 * The rules (`services/openApproval.ts`) are mocked: they are tested in
 * `openApproval.test.ts`. What is tested is what the chat shows.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER = '00000000-0000-0000-0000-000000000001';
const PROPOSAL = '11111111-2222-3333-4444-555555555555';
const CHAT = 987654321;
const WEBHOOK_SECRET = 'a-webhook-secret-long-enough';
const SIGNING_SECRET = 'a-signing-secret-long-enough';
/** 16:30 in Jerusalem, the US open in winter. */
const OPENS_AT = '2026-11-19T14:30:00.000Z';
/**
 * The chat's clock, an hour before that open. The keyboard reads the clock, so
 * a test on the real one passed until 14:30 UTC that day and failed after it.
 */
const NOW = new Date(Date.parse(OPENS_AT) - 3_600_000);

let language = 'en';
let openApproval: string | null = null;

vi.mock('../src/db/pool.js', () => ({
  queryOne: vi.fn(async () => null),
  query: vi.fn(async () => []),
  transaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({})),
  initPool: vi.fn(),
  getPool: vi.fn(),
  closePool: vi.fn(),
}));

vi.mock('../src/db/queries.js', () => ({
  findTelegramBindingByChat: vi.fn(async () => ({
    user_id: USER,
    chat_id: String(CHAT),
    username: 'someone',
    bound_at: new Date(),
    legal_accepted: true,
  })),
  findProposal: vi.fn(async () => ({
    id: PROPOSAL,
    kind: 'buy',
    agent_id: 'agent-1',
    state: 'pending',
    expires_at: new Date(Date.parse(OPENS_AT) + 3_600_000),
    snoozed_until: null,
    decided_at: null,
    opens_at: new Date(OPENS_AT),
    open_approval: openApproval,
  })),
  getUser: vi.fn(async () => ({ id: USER, email: null, base_currency: 'USD', timezone: 'Asia/Jerusalem' })),
  getOrCreateUserSettings: vi.fn(async () => ({ notify_severity: 'high', language })),
  latestRecheck: vi.fn(async () => null),
  rememberTelegramProposalMessage: vi.fn(async () => undefined),
  laterApprovedProposal: vi.fn(async () => null),
}));

vi.mock('../src/services/openApproval.js', () => ({
  approveForOpen: vi.fn(),
  cancelForOpen: vi.fn(),
}));

vi.mock('../src/services/tradeApproval.js', () => ({
  previewTradeApproval: vi.fn(),
  confirmTradeApproval: vi.fn(),
}));

const { loadConfig, resetConfigForTests } = await import('../src/config.js');
const { createApp } = await import('../src/http/app.js');
const { createFakeAi } = await import('./fakeAi.js');
const { TelegramNotifier } = await import('../src/telegram/client.js');
const { decodeCallbackData, encodeCallbackData, mintNonce } = await import('../src/telegram/callbackToken.js');
const { MESSAGES } = await import('../src/notify/messages.js');
const { ApiProblem } = await import('../src/http/errors.js');
const service = await import('../src/services/openApproval.js');
const queries = await import('../src/db/queries.js');
const approval = await import('../src/services/tradeApproval.js');
const { tradeKeyboard } = await import('../src/telegram/tradeApproval.js');

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

let sentCalls: { method: string; body: Record<string, unknown> }[] = [];
let notifier: InstanceType<typeof TelegramNotifier>;

function buildApp() {
  resetConfigForTests();
  sentCalls = [];
  notifier = new TelegramNotifier({
    botToken: 'bot-token',
    callbackSecret: SIGNING_SECRET,
    resolveChatId: async () => String(CHAT),
    fetchImpl: async (url, init) => {
      sentCalls.push({ method: url.split('/').pop() as string, body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response('{"ok":true}', { status: 200 });
    },
  });
  return createApp(loadConfig(ENV), createFakeAi(), notifier);
}

let app: ReturnType<typeof buildApp>;

const HEADLINE = 'Warren proposes to buy 3 NVDA at 155.46';

const tap = (action: 'queue' | 'unqueue') =>
  app.request('/telegram/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
    body: JSON.stringify({
      callback_query: {
        id: 'cb-1',
        data: encodeCallbackData({ proposalId: PROPOSAL, action, nonce: mintNonce() }, SIGNING_SECRET),
        message: { message_id: 99, text: HEADLINE, chat: { id: CHAT, type: 'private' } },
      },
    }),
  });

type Button = { text: string; callback_data?: string };
const toast = () => String(sentCalls.find((call) => call.method === 'answerCallbackQuery')?.body.text);
const lastEdit = () => sentCalls.filter((call) => call.method.startsWith('editMessage')).at(-1)!;
const keyboardOf = (call: { body: Record<string, unknown> }) =>
  ((call.body.reply_markup as { inline_keyboard: Button[][] }).inline_keyboard ?? []).flat();
const labels = (call: { body: Record<string, unknown> }) => keyboardOf(call).map((button) => button.text);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  language = 'en';
  openApproval = null;
  vi.mocked(service.approveForOpen).mockResolvedValue({ outcome: 'queued', opensAt: OPENS_AT });
  vi.mocked(service.cancelForOpen).mockResolvedValue({ outcome: 'cancelled' });
  app = buildApp();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the announcement of a trade raised while the market is closed', () => {
  it('offers Approve at the open and Reject, the first signed as queue', async () => {
    await notifier.send({
      userId: USER,
      title: HEADLINE,
      body: 'thesis',
      proposalId: PROPOSAL,
      trade: true,
      atOpen: true,
      severity: 'notable',
      language: 'en',
    });
    expect(labels(sentCalls[0]!)).toEqual([MESSAGES.en.openApproval.approveButton, MESSAGES.en.buttons.reject]);
    const first = keyboardOf(sentCalls[0]!)[0]!;
    expect(decodeCallbackData(first.callback_data!, SIGNING_SECRET)?.action).toBe('queue');
  });

  it("offers Re-check beside Approve and Reject on the open's refusal for a moved price (D431)", async () => {
    await notifier.send({
      userId: USER,
      title: HEADLINE,
      body: 'refused',
      proposalId: PROPOSAL,
      trade: true,
      recheck: true,
      severity: 'notable',
      language: 'en',
    });
    expect(labels(sentCalls[0]!)).toEqual([
      MESSAGES.en.buttons.approve,
      MESSAGES.en.buttons.reject,
      MESSAGES.en.recheck.button,
    ]);
  });

  it('keeps Approve for a trade raised while the market is open', async () => {
    await notifier.send({ userId: USER, title: HEADLINE, body: 't', proposalId: PROPOSAL, trade: true, severity: 'notable', language: 'en' });
    expect(labels(sentCalls[0]!)).toEqual([MESSAGES.en.buttons.approve, MESSAGES.en.buttons.reject]);
  });
});

describe('the buttons a trade carries (tradeKeyboard)', () => {
  const before = new Date(Date.parse(OPENS_AT) - 60_000);
  const after = new Date(Date.parse(OPENS_AT) + 60_000);
  const opens_at = new Date(OPENS_AT);

  it('reads its row and the clock', () => {
    expect(tradeKeyboard({ opens_at, open_approval: null }, 'pending', before)).toBe('tradeAtOpen');
    expect(tradeKeyboard({ opens_at, open_approval: 'queued' }, 'pending', before)).toBe('openQueued');
    expect(tradeKeyboard({ opens_at, open_approval: 'cancelled' }, 'pending', after)).toBe('trade');
    expect(tradeKeyboard({ opens_at: null, open_approval: null }, 'pending', before)).toBe('trade');
    expect(tradeKeyboard({ opens_at, open_approval: 'queued' }, 'rejected', before)).toBe('none');
  });
});

describe('a tap', () => {
  it('on Approve at the open queues it, says when it fills, and offers Cancel', async () => {
    await tap('queue');
    expect(service.approveForOpen).toHaveBeenCalledWith(USER, PROPOSAL, 'telegram', expect.any(Date));
    expect(toast()).toBe(MESSAGES.en.openApproval.queuedToast);
    const edit = lastEdit();
    expect(String(edit.body.text)).toContain(HEADLINE);
    expect(String(edit.body.text)).toContain('it fills at');
    expect(String(edit.body.text)).toContain('16:30');
    expect(labels(edit)).toContain(MESSAGES.en.openApproval.cancelButton);
    expect(labels(edit)).toContain(MESSAGES.en.buttons.reject);
  });

  it('on Approve at the open remembers the message, so the open can redraw it (D427)', async () => {
    await tap('queue');
    expect(queries.rememberTelegramProposalMessage).toHaveBeenCalledWith(USER, PROPOSAL, String(CHAT), 99, false);
  });

  it('remembers nothing when the queue was refused', async () => {
    vi.mocked(service.approveForOpen).mockRejectedValue(new ApiProblem(422, 'already_decided', 'no'));
    await tap('queue');
    expect(queries.rememberTelegramProposalMessage).not.toHaveBeenCalled();
  });

  it('on Cancel approval says so and brings Approve at the open back', async () => {
    await tap('unqueue');
    expect(toast()).toBe(MESSAGES.en.openApproval.cancelledToast);
    const edit = lastEdit();
    expect(String(edit.body.text)).toContain('cancelled');
    expect(labels(edit)).toContain(MESSAGES.en.openApproval.approveButton);
  });

  it('on Approve at the open after the open is answered as Approve: the live preview', async () => {
    vi.mocked(service.approveForOpen).mockRejectedValue(new ApiProblem(422, 'market_open', 'open'));
    vi.mocked(approval.previewTradeApproval).mockRejectedValue(new ApiProblem(422, 'quote_unavailable', 'none'));
    await tap('queue');
    expect(approval.previewTradeApproval).toHaveBeenCalledWith(USER, PROPOSAL, 'telegram', expect.anything());
  });

  it('on Cancel with nothing waiting says so, and leaves the buttons the row calls for', async () => {
    openApproval = 'filled';
    vi.mocked(service.cancelForOpen).mockRejectedValue(new ApiProblem(422, 'open_approval_not_waiting', 'no'));
    await tap('unqueue');
    expect(toast()).toBe(MESSAGES.en.openApproval.notWaitingToast);
  });

  it('says what is set aside when the free cash does not cover the approval (D428)', async () => {
    vi.mocked(service.approveForOpen).mockRejectedValue(
      new ApiProblem(422, 'insufficient_cash', 'short', { cashMinor: 50_000, reservedMinor: 40_100, requiredMinor: 46_738 }),
    );
    await tap('queue');
    expect(toast()).toBe(MESSAGES.en.trade.cashSetAside('$467.38', '$99.00', '$401.00'));
  });

  it('says which shares are set aside when a waiting sell holds them (D428)', async () => {
    const short = (details: Record<string, unknown>) => new ApiProblem(422, 'insufficient_holding', 'short', details);
    vi.mocked(service.approveForOpen).mockRejectedValue(short({ heldQuantity: '4', reservedQuantity: '2' }));
    await tap('queue');
    expect(toast()).toBe(MESSAGES.en.trade.sharesSetAside('4', '2'));
  });

  it('keeps the plain reason when no waiting sell holds the shares', async () => {
    vi.mocked(service.approveForOpen).mockRejectedValue(
      new ApiProblem(422, 'insufficient_holding', 'short', { heldQuantity: '1', reservedQuantity: '0' }),
    );
    await tap('queue');
    expect(toast()).toBe(MESSAGES.en.trade.reasons.insufficient_holding);
  });

  it('speaks Hebrew to a Hebrew user', async () => {
    language = 'he';
    await tap('queue');
    expect(toast()).toBe(MESSAGES.he.openApproval.queuedToast);
    expect(String(lastEdit().body.text)).toContain('אושר לפתיחה');
    expect(labels(lastEdit())).toContain(MESSAGES.he.openApproval.cancelButton);
  });
});
