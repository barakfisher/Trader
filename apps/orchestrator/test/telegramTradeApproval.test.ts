/**
 * Approving an agent's trade from Telegram (D47, D60-D62): *Approve* answers
 * with the preview and a Confirm carrying the previewed price, *Confirm* fills
 * at that price, and a refusal keeps Approve and Reject with its reason.
 *
 * The money path (`services/tradeApproval.ts`) is mocked here - it is tested
 * in `tradeProposals.test.ts`; what is tested is what the chat shows and which
 * price reaches the service. No bot token and no network, as in
 * `telegramWebhook.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = '00000000-0000-0000-0000-000000000001';
const PROPOSAL = '11111111-2222-3333-4444-555555555555';
const CHAT = 987654321;
const WEBHOOK_SECRET = 'a-webhook-secret-long-enough';
const SIGNING_SECRET = 'a-signing-secret-long-enough';

let language = 'en';
let kind = 'buy';

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
  })),
  findProposal: vi.fn(async () => ({
    id: PROPOSAL,
    kind,
    state: 'pending',
    expires_at: new Date(Date.now() + 3_600_000),
    snoozed_until: null,
    decided_at: null,
  })),
  getUser: vi.fn(async () => ({ id: USER, email: null, base_currency: 'USD', timezone: 'Asia/Jerusalem' })),
  getOrCreateUserSettings: vi.fn(async () => ({ notify_severity: 'high', language })),
}));

vi.mock('../src/services/tradeApproval.js', () => ({
  previewTradeApproval: vi.fn(),
  confirmTradeApproval: vi.fn(),
}));

vi.mock('../src/services/proposals.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/proposals.js')>(
    '../src/services/proposals.js',
  );
  return { ...actual, applyDecision: vi.fn(async () => ({ outcome: 'applied', state: 'rejected' })) };
});

const { loadConfig, resetConfigForTests } = await import('../src/config.js');
const { createApp } = await import('../src/http/app.js');
const { createFakeAi } = await import('./fakeAi.js');
const { TelegramNotifier } = await import('../src/telegram/client.js');
const { decodeCallbackData, encodeCallbackData, mintNonce, MAX_CALLBACK_PRICE_MINOR } = await import(
  '../src/telegram/callbackToken.js'
);
const approval = await import('../src/services/tradeApproval.js');
const proposals = await import('../src/services/proposals.js');
const { ApiProblem } = await import('../src/http/errors.js');
const { bpsAsPercent } = await import('../src/telegram/tradeApproval.js');

const ENV = {
  APP_ENV: 'test',
  LOG_LEVEL: 'error',
  APP_PASSPHRASE: 'test-passphrase',
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

const HEADLINE = 'Value proposes to buy 2 NVDA at 238.68';

const tap = (action: 'approve' | 'confirm' | 'reject', priceMinor?: bigint) =>
  app.request('/telegram/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
    body: JSON.stringify({
      callback_query: {
        id: 'cb-1',
        data: encodeCallbackData(
          { proposalId: PROPOSAL, action, nonce: mintNonce(), ...(priceMinor === undefined ? {} : { priceMinor }) },
          SIGNING_SECRET,
        ),
        message: { message_id: 99, text: HEADLINE, chat: { id: CHAT } },
      },
    }),
  });

const toast = () => String(sentCalls.find((call) => call.method === 'answerCallbackQuery')?.body.text);
const lastEdit = () => sentCalls.filter((call) => call.method.startsWith('editMessage')).at(-1)!;
const keyboardOf = (call: { body: Record<string, unknown> }) =>
  ((call.body.reply_markup as { inline_keyboard: { text: string; callback_data?: string }[][] }).inline_keyboard ?? []).flat();

const PREVIEW = {
  proposalId: PROPOSAL,
  agentPriceMinor: 23_868,
  distanceBps: 25,
  maxDistanceBps: 300,
  trade: {
    symbol: 'NVDA',
    name: 'NVIDIA',
    side: 'buy',
    quantity: '2',
    priceSource: 'quote',
    priceMinor: 23_928,
    quoteAsOf: '2026-10-07T15:00:00Z',
    quoteDelaySeconds: 0,
    notionalMinor: 47_856,
    feeMinor: 150,
    cashChangeMinor: -48_006,
    cashMinor: 1_000_000,
    cashAfterMinor: 951_994,
    heldQuantity: '0',
    heldAfterQuantity: '2',
    currency: 'USD',
    warnings: [],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  language = 'en';
  kind = 'buy';
  vi.mocked(approval.previewTradeApproval).mockResolvedValue(PREVIEW as never);
  app = buildApp();
});

describe('the announcement', () => {
  it('offers Approve and Reject only on a trade (D48)', async () => {
    await notifier.send({ userId: USER, title: HEADLINE, body: 'thesis', proposalId: PROPOSAL, trade: true, severity: 'notable', language: 'en' });
    expect(keyboardOf(sentCalls[0]!).map((button) => button.text)).toEqual(['Approve', 'Reject']);
  });
});

describe('Approve: the preview at the live price (D47)', () => {
  it('shows both prices, the cost and the cash after, with Confirm carrying the live price', async () => {
    await tap('approve');
    expect(approval.previewTradeApproval).toHaveBeenCalledWith(USER, PROPOSAL, 'telegram', expect.anything());
    const edit = lastEdit();
    expect(edit.method).toBe('editMessageText');
    const text = String(edit.body.text);
    expect(text.startsWith(HEADLINE)).toBe(true);
    expect(text).toContain('$239.28');
    expect(text).toContain('$238.68 (+0.25%)');
    expect(text).toContain('fee $1.50');
    expect(text).toContain('cash after $9,519.94');
    const buttons = keyboardOf(edit);
    expect(buttons.map((button) => button.text)).toEqual(['Confirm', 'Reject']);
    expect(decodeCallbackData(buttons[0]!.callback_data!, SIGNING_SECRET)).toMatchObject({
      action: 'confirm',
      priceMinor: 23_928n,
    });
    expect(toast()).toContain('Confirm');
  });

  it('is written in the user’s language', async () => {
    language = 'he';
    await tap('approve');
    expect(String(lastEdit().body.text)).toContain('במחיר העדכני');
    expect(keyboardOf(lastEdit()).map((button) => button.text)).toEqual(['אישור סופי', 'דחייה']);
  });

  it('offers no Confirm for a price no button can carry', async () => {
    vi.mocked(approval.previewTradeApproval).mockResolvedValueOnce({
      ...PREVIEW,
      trade: { ...PREVIEW.trade, priceMinor: Number(MAX_CALLBACK_PRICE_MINOR) + 1 },
    } as never);
    await tap('approve');
    expect(keyboardOf(lastEdit()).map((button) => button.text)).toEqual(['Reject']);
    expect(String(lastEdit().body.text)).toContain('confirm it in the app');
  });

  it('a closed market names the next open in the user’s time, and keeps Approve and Reject (D62)', async () => {
    vi.mocked(approval.previewTradeApproval).mockRejectedValueOnce(
      new ApiProblem(422, 'market_closed', 'closed', { nextOpen: '2026-10-08T13:30:00Z' }),
    );
    await tap('approve');
    const text = String(lastEdit().body.text);
    // 13:30 UTC is 16:30 in Jerusalem.
    expect(text).toContain('opens');
    expect(text).toContain('16:30');
    expect(text).toContain('Still open until it expires');
    expect(keyboardOf(lastEdit()).map((button) => button.text)).toEqual(['Approve', 'Reject']);
    expect(toast()).toContain('16:30');
  });

  it("names both prices when the live one is too far from the agent's", async () => {
    vi.mocked(approval.previewTradeApproval).mockRejectedValueOnce(
      new ApiProblem(422, 'price_far_from_agent', 'far', {
        agentPriceMinor: 23_868,
        livePriceMinor: 24_800,
        distanceBps: 390,
      }),
    );
    await tap('approve');
    expect(toast()).toBe("The price is $248.00, +3.90% from the agent's $238.68 - more than 3%.");
  });

  it('takes the buttons away from an expired proposal', async () => {
    vi.mocked(approval.previewTradeApproval).mockRejectedValueOnce(new ApiProblem(422, 'expired', 'expired'));
    await tap('approve');
    expect(keyboardOf(lastEdit())).toEqual([]);
    expect(String(lastEdit().body.text)).toContain('Expired');
  });
});

describe('Confirm: the fill at the previewed price', () => {
  it('fills at the signed price and leaves no buttons (D48: no undo)', async () => {
    vi.mocked(approval.confirmTradeApproval).mockResolvedValueOnce({
      state: 'approved',
      fill: {
        id: 'f-1',
        symbol: 'NVDA',
        side: 'buy',
        quantity: '2',
        priceMinor: 23_930,
        notionalMinor: 47_860,
        feeMinor: 150,
        currency: 'USD',
        priceSource: 'quote',
        quoteAsOf: null,
        quoteDelaySeconds: null,
        source: 'agent',
        createdAt: '2026-10-07T15:00:00Z',
      },
      cashMinor: 951_990,
      heldQuantity: '2',
    } as never);
    await tap('confirm', 23_928n);
    expect(approval.confirmTradeApproval).toHaveBeenCalledWith(USER, PROPOSAL, 23_928n, 'telegram', expect.anything());
    const text = String(lastEdit().body.text);
    expect(text).toContain('Bought 2 NVDA at $239.30, fee $1.50; cash $9,519.90');
    expect(text).toContain('no order was placed');
    expect(keyboardOf(lastEdit())).toEqual([]);
  });

  it('a price that moved is refused, and Approve comes back for a fresh preview', async () => {
    vi.mocked(approval.confirmTradeApproval).mockRejectedValueOnce(
      new ApiProblem(409, 'price_moved', 'moved', { shownPriceMinor: 23_928, livePriceMinor: 24_100 }),
    );
    await tap('confirm', 23_928n);
    expect(toast()).toContain('Approve again');
    expect(keyboardOf(lastEdit()).map((button) => button.text)).toEqual(['Approve', 'Reject']);
  });

  it('a Confirm on a proposal that is not a trade decides nothing', async () => {
    kind = 'rebalance';
    await tap('confirm', 100n);
    expect(approval.confirmTradeApproval).not.toHaveBeenCalled();
    expect(proposals.applyDecision).not.toHaveBeenCalled();
  });
});

describe('Reject', () => {
  it('goes through the shared transition, and a rejected trade keeps no buttons', async () => {
    await tap('reject');
    expect(proposals.applyDecision).toHaveBeenCalledWith(expect.objectContaining({ action: 'reject', surface: 'telegram' }));
    expect(approval.previewTradeApproval).not.toHaveBeenCalled();
    expect(keyboardOf(lastEdit())).toEqual([]);
  });
});

describe('bpsAsPercent', () => {
  it.each([
    [25, '+0.25%'],
    [-390, '-3.90%'],
    [0, '+0.00%'],
    [1234, '+12.34%'],
  ])('%s bps reads %s', (bps, text) => {
    expect(bpsAsPercent(bps)).toBe(text);
  });
});
