/**
 * The Telegram webhook: a public endpoint, tested as one.
 *
 * Every test here is about something an attacker or a confused client can do -
 * post without the secret, forward a message and tap its buttons, replay a
 * callback, redeem a link twice. The happy path is the short part.
 *
 * No bot token and no network: the Telegram client takes its `fetch` as a
 * constructor argument, so the whole adapter runs against a recorded fake.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER = '00000000-0000-0000-0000-000000000001';
const PROPOSAL = '11111111-2222-3333-4444-555555555555';
const CHAT = 987654321;
const WEBHOOK_SECRET = 'a-webhook-secret-long-enough';
const SIGNING_SECRET = 'a-signing-secret-long-enough';

vi.mock('../src/db/pool.js', () => ({
  queryOne: vi.fn(async () => null),
  query: vi.fn(async () => []),
  transaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({})),
  initPool: vi.fn(),
  getPool: vi.fn(),
  closePool: vi.fn(),
}));

vi.mock('../src/db/queries.js', () => ({
  findTelegramBindingByChat: vi.fn(async () => null),
  findTelegramBindingByUser: vi.fn(async () => null),
  redeemTelegramBindToken: vi.fn(async () => ({ bound: true })),
  deleteTelegramBinding: vi.fn(async () => true),
  muteUntil: vi.fn(async () => undefined),
  listProposals: vi.fn(async () => []),
  // Re-read to decide whether a message still gets Undo. Defaults to an
  // approval made just now, inside its window.
  findProposal: vi.fn(async () => ({
    id: '11111111-2222-3333-4444-555555555555',
    state: 'approved',
    expires_at: new Date(Date.now() + 3_600_000),
    snoozed_until: null,
    decided_at: new Date(),
  })),
  getUser: vi.fn(async () => ({
    id: USER,
    email: null,
    base_currency: 'USD',
    timezone: 'Asia/Jerusalem',
  })),
  getOrCreateUserSettings: vi.fn(async () => ({
    proposal_severity: 'high',
    proposal_ttl_hours: 24,
    notify_severity: 'high',
    quiet_hours_start: '22:00',
    quiet_hours_end: '07:00',
    muted_until: null,
  })),
  transaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({})),
}));

vi.mock('../src/services/proposals.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/proposals.js')>(
    '../src/services/proposals.js',
  );
  return { ...actual, applyDecision: vi.fn(async () => ({ outcome: 'applied', state: 'approved', intentId: 'i-1' })) };
});

const { loadConfig, resetConfigForTests } = await import('../src/config.js');
const { createApp } = await import('../src/http/app.js');
const { createFakeAi } = await import('./fakeAi.js');
const { TelegramNotifier } = await import('../src/telegram/client.js');
const { encodeBindToken } = await import('../src/telegram/bindToken.js');
const { BUSY_CALLBACK_DATA, decodeCallbackData, encodeCallbackData, mintNonce } = await import(
  '../src/telegram/callbackToken.js'
);
const queries = await import('../src/db/queries.js');
const { MESSAGES } = await import('../src/notify/messages.js');
const proposals = await import('../src/services/proposals.js');
const { UNDO_WINDOW_SECONDS } = await import('../src/services/proposalState.js');

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

/** Records every Telegram API call instead of making one. */
let sentCalls: { method: string; body: Record<string, unknown> }[] = [];

function buildApp() {
  resetConfigForTests();
  sentCalls = [];
  const notifier = new TelegramNotifier({
    botToken: 'bot-token',
    callbackSecret: SIGNING_SECRET,
    resolveChatId: async () => String(CHAT),
    fetchImpl: async (url, init) => {
      sentCalls.push({
        method: url.split('/').pop() as string,
        body: JSON.parse(String(init?.body ?? '{}')),
      });
      return new Response('{"ok":true}', { status: 200 });
    },
  });
  return createApp(loadConfig(ENV), createFakeAi(), notifier);
}

let app: ReturnType<typeof buildApp>;

const post = (body: unknown, secret: string | null = WEBHOOK_SECRET) =>
  app.request('/telegram/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret === null ? {} : { 'x-telegram-bot-api-secret-token': secret }),
    },
    body: JSON.stringify(body),
  });

const callbackUpdate = (data: string) => ({
  callback_query: {
    id: 'cb-1',
    data,
    message: {
      message_id: 99,
      text: 'VOO is 12.4pp above your target weight',
      chat: { id: CHAT },
    },
  },
});

const messageUpdate = (text: string) => ({
  message: { text, chat: { id: CHAT }, from: { username: 'someone' } },
});

/** The text of the toast a tap was answered with. */
const toast = () =>
  String(sentCalls.find((call) => call.method === 'answerCallbackQuery')?.body.text);

/** The labels of the buttons a message was left with, row by row flattened. */
const buttonsOf = (call: { body: Record<string, unknown> } | undefined) =>
  (
    (call?.body.reply_markup as { inline_keyboard: { text: string }[][] } | undefined)
      ?.inline_keyboard ?? []
  )
    .flat()
    .map((button) => button.text);

const bound = () =>
  vi.mocked(queries.findTelegramBindingByChat).mockResolvedValue({
    user_id: USER,
    chat_id: String(CHAT),
    username: 'someone',
    bound_at: new Date(),
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(queries.findTelegramBindingByChat).mockResolvedValue(null);
  vi.mocked(queries.redeemTelegramBindToken).mockResolvedValue({ bound: true });
  vi.mocked(proposals.applyDecision).mockResolvedValue({
    outcome: 'applied',
    state: 'approved',
    intentId: 'i-1',
  } as never);
  app = buildApp();
});

describe('the secret header', () => {
  it('refuses an update with no secret at all', async () => {
    const response = await post(messageUpdate('/pending'), null);
    expect(response.status).toBe(401);
    expect(sentCalls).toHaveLength(0);
  });

  it('refuses an update with the wrong secret', async () => {
    expect((await post(messageUpdate('/pending'), 'not-the-secret')).status).toBe(401);
  });

  it('does not even parse the body when the secret is wrong', async () => {
    // An unauthenticated caller must not be able to make us do work.
    const response = await app.request('/telegram/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'this is not json at all',
    });
    expect(response.status).toBe(401);
  });
});

describe('an unbound chat', () => {
  it('is ignored in silence', async () => {
    // F4: replying would confirm the bot exists to whoever found it.
    const response = await post(messageUpdate('/pending'));
    expect(response.status).toBe(200);
    expect(sentCalls).toHaveLength(0);
  });

  it('cannot decide a proposal even with a validly signed button', async () => {
    // The forwarded-message case: the signature is genuine because we minted
    // it, but the chat that tapped it is not the chat it was sent to.
    const data = encodeCallbackData(
      { proposalId: PROPOSAL, action: 'approve', nonce: mintNonce() },
      SIGNING_SECRET,
    );
    await post(callbackUpdate(data));
    expect(proposals.applyDecision).not.toHaveBeenCalled();
    expect(sentCalls[0]?.method).toBe('answerCallbackQuery');
  });
});

describe('a signed callback from a bound chat', () => {
  beforeEach(() => bound());

  it('applies the decision and answers the tap', async () => {
    const nonce = mintNonce();
    const data = encodeCallbackData({ proposalId: PROPOSAL, action: 'approve', nonce }, SIGNING_SECRET);
    await post(callbackUpdate(data));

    expect(vi.mocked(proposals.applyDecision).mock.calls[0]![0]).toEqual(
      expect.objectContaining({
        userId: USER,
        proposalId: PROPOSAL,
        action: 'approve',
        surface: 'telegram',
        // The nonce becomes the audit row's idempotency key, which is what
        // makes a replay lose a database race rather than pass a check.
        idempotencyKey: nonce,
      }),
    );
    expect(toast()).toContain('Approved');
  });

  it('acts for the chat’s bound user, never for a user named in the payload', async () => {
    // There is nowhere in callback_data to put a user id, and this is why: the
    // identity comes from the binding, so a forged payload cannot choose it.
    const data = encodeCallbackData(
      { proposalId: PROPOSAL, action: 'reject', nonce: mintNonce() },
      SIGNING_SECRET,
    );
    await post(callbackUpdate(data));
    expect(vi.mocked(proposals.applyDecision).mock.calls[0]![0].userId).toBe(USER);
  });

  it('carries a snooze deadline, since the bot has no time picker', async () => {
    const data = encodeCallbackData(
      { proposalId: PROPOSAL, action: 'snooze', nonce: mintNonce() },
      SIGNING_SECRET,
    );
    await post(callbackUpdate(data));
    expect(vi.mocked(proposals.applyDecision).mock.calls[0]![0].snoozeUntil).toBeInstanceOf(Date);
  });

  it('rejects a payload signed with the wrong secret', async () => {
    const data = encodeCallbackData(
      { proposalId: PROPOSAL, action: 'approve', nonce: mintNonce() },
      'a-forged-secret',
    );
    await post(callbackUpdate(data));
    expect(proposals.applyDecision).not.toHaveBeenCalled();
  });

  it('rejects a payload whose action was edited', async () => {
    const data = encodeCallbackData(
      { proposalId: PROPOSAL, action: 'reject', nonce: mintNonce() },
      SIGNING_SECRET,
    );
    await post(callbackUpdate(`${data.slice(0, 22)}a${data.slice(23)}`));
    expect(proposals.applyDecision).not.toHaveBeenCalled();
  });

  it('answers a replay with the current state instead of deciding again', async () => {
    // The state machine reports 'unchanged'; the user gets told what is true.
    vi.mocked(proposals.applyDecision).mockResolvedValueOnce({
      outcome: 'unchanged',
      state: 'approved',
    } as never);
    const data = encodeCallbackData(
      { proposalId: PROPOSAL, action: 'approve', nonce: mintNonce() },
      SIGNING_SECRET,
    );
    await post(callbackUpdate(data));
    expect(toast()).toContain('Approved');
  });

  it('tells the user when the proposal expired under them', async () => {
    vi.mocked(proposals.applyDecision).mockResolvedValueOnce({
      outcome: 'refused',
      reason: 'expired',
      state: 'expired',
    } as never);
    const data = encodeCallbackData(
      { proposalId: PROPOSAL, action: 'approve', nonce: mintNonce() },
      SIGNING_SECRET,
    );
    await post(callbackUpdate(data));
    expect(toast()).toContain('expired');
  });

  it('rewrites the message so the chat keeps a record of the decision', async () => {
    // FLOWS.md F4. Without this the alert sits in the history for ever with
    // three live-looking buttons and nothing saying what was decided - and
    // answerCallbackQuery cannot serve, because it is a toast that vanishes.
    const data = encodeCallbackData(
      { proposalId: PROPOSAL, action: 'approve', nonce: mintNonce() },
      SIGNING_SECRET,
    );
    await post(callbackUpdate(data));

    const edit = sentCalls.find((call) => call.method === 'editMessageText');
    expect(edit).toBeDefined();
    expect(edit!.body.message_id).toBe(99);
    // The original text is kept and the outcome appended, rather than replaced:
    // a message that loses what it was about is not a record of anything.
    expect(String(edit!.body.text)).toContain('VOO is 12.4pp above your target weight');
    expect(String(edit!.body.text)).toContain('Approved');
  });

  it('leaves an approval with a single Undo button', async () => {
    // Leaving a live Approve button on something already approved invites a tap
    // that can only be refused; Undo is the one thing an approval still allows.
    const data = encodeCallbackData(
      { proposalId: PROPOSAL, action: 'approve', nonce: mintNonce() },
      SIGNING_SECRET,
    );
    await post(callbackUpdate(data));

    const edit = sentCalls.find((call) => call.method === 'editMessageText');
    expect(buttonsOf(edit)).toEqual([expect.stringContaining('Undo')]);
  });

  it('removes the buttons once a proposal is rejected', async () => {
    vi.mocked(proposals.applyDecision).mockResolvedValueOnce({
      outcome: 'applied',
      state: 'rejected',
      intentId: null,
    } as never);
    const data = encodeCallbackData(
      { proposalId: PROPOSAL, action: 'reject', nonce: mintNonce() },
      SIGNING_SECRET,
    );
    await post(callbackUpdate(data));

    const edit = sentCalls.find((call) => call.method === 'editMessageText');
    expect(edit!.body.reply_markup).toEqual({ inline_keyboard: [] });
  });

  it('keeps the buttons on a snooze, which is not a decision', async () => {
    // "Not now" leaves the question open: the user may still approve before the
    // deadline, and taking the buttons away would make them go and find the app.
    vi.mocked(proposals.applyDecision).mockResolvedValueOnce({
      outcome: 'applied',
      state: 'snoozed',
      intentId: null,
    } as never);
    const data = encodeCallbackData(
      { proposalId: PROPOSAL, action: 'snooze', nonce: mintNonce() },
      SIGNING_SECRET,
    );
    await post(callbackUpdate(data));

    const edit = sentCalls.find((call) => call.method === 'editMessageText');
    // Sent explicitly, not left alone: by now the message carries the
    // "Snoozing…" placeholder, and keeping *that* would strand the user.
    expect(buttonsOf(edit)).toEqual(['Approve', 'Reject', 'Snooze']);
    expect(String(edit!.body.text)).toContain('Snoozed');
  });

  it('swaps the buttons for an inert placeholder before deciding', async () => {
    // The visible "your tap registered", and the lock: nothing else on the
    // message can be pressed while the decision is in flight.
    let markupWhenDeciding: string[] = [];
    vi.mocked(proposals.applyDecision).mockImplementationOnce(async () => {
      markupWhenDeciding = buttonsOf(
        sentCalls.find((call) => call.method === 'editMessageReplyMarkup'),
      );
      return { outcome: 'applied', state: 'approved', intentId: 'i-1' } as never;
    });
    const data = encodeCallbackData(
      { proposalId: PROPOSAL, action: 'approve', nonce: mintNonce() },
      SIGNING_SECRET,
    );
    await post(callbackUpdate(data));

    expect(markupWhenDeciding).toEqual([expect.stringContaining('Approving')]);
    const placeholder = sentCalls.find((call) => call.method === 'editMessageReplyMarkup');
    const [[button]] = (placeholder!.body.reply_markup as { inline_keyboard: { callback_data: string }[][] })
      .inline_keyboard as [[{ callback_data: string }]];
    expect(button.callback_data).toBe(BUSY_CALLBACK_DATA);
  });

  it('answers a tap on the placeholder and decides nothing', async () => {
    await post(callbackUpdate(BUSY_CALLBACK_DATA));
    expect(proposals.applyDecision).not.toHaveBeenCalled();
    expect(toast()).toContain('Still working');
  });

  it('restores the buttons the current state allows when a tap changes nothing', async () => {
    // A stale message - decided on the web a minute ago - heals on its next tap
    // rather than keeping the placeholder or buttons that no longer apply.
    vi.mocked(proposals.applyDecision).mockResolvedValueOnce({
      outcome: 'refused',
      reason: 'already_decided',
      state: 'approved',
    } as never);
    const data = encodeCallbackData(
      { proposalId: PROPOSAL, action: 'reject', nonce: mintNonce() },
      SIGNING_SECRET,
    );
    await post(callbackUpdate(data));

    const markups = sentCalls.filter((call) => call.method === 'editMessageReplyMarkup');
    expect(buttonsOf(markups.at(-1))).toEqual([expect.stringContaining('Undo')]);
    // Nothing happened, so the message text gains no outcome line.
    expect(sentCalls.some((call) => call.method === 'editMessageText')).toBe(false);
  });

  it('takes Undo away when a late tap finds the window closed', async () => {
    vi.mocked(queries.findProposal).mockResolvedValueOnce({
      id: PROPOSAL,
      state: 'approved',
      expires_at: new Date(Date.now() + 3_600_000),
      snoozed_until: null,
      decided_at: new Date(Date.now() - (UNDO_WINDOW_SECONDS + 5) * 1000),
    } as never);
    vi.mocked(proposals.applyDecision).mockResolvedValueOnce({
      outcome: 'refused',
      reason: 'undo_window_closed',
      state: 'approved',
    } as never);
    await post(
      callbackUpdate(
        encodeCallbackData({ proposalId: PROPOSAL, action: 'undo', nonce: mintNonce() }, SIGNING_SECRET),
      ),
    );
    expect(toast()).toContain('Too late to undo');
    const markups = sentCalls.filter((call) => call.method === 'editMessageReplyMarkup');
    expect(markups.at(-1)!.body.reply_markup).toEqual({ inline_keyboard: [] });
  });

  it('removes the Undo button by itself when the window closes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const data = encodeCallbackData(
        { proposalId: PROPOSAL, action: 'approve', nonce: mintNonce() },
        SIGNING_SECRET,
      );
      await post(callbackUpdate(data));
      const before = sentCalls.length;

      await vi.advanceTimersByTimeAsync(UNDO_WINDOW_SECONDS * 1000);
      const removal = sentCalls.slice(before).find((call) => call.method === 'editMessageReplyMarkup');
      expect(removal!.body.reply_markup).toEqual({ inline_keyboard: [] });
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves the buttons alone if the approval was undone before the window closed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const data = encodeCallbackData(
        { proposalId: PROPOSAL, action: 'approve', nonce: mintNonce() },
        SIGNING_SECRET,
      );
      await post(callbackUpdate(data));
      vi.mocked(queries.findProposal).mockResolvedValueOnce({
        id: PROPOSAL,
        state: 'pending',
        expires_at: new Date(Date.now() + 3_600_000),
        snoozed_until: null,
        decided_at: new Date(),
      } as never);
      const before = sentCalls.length;

      await vi.advanceTimersByTimeAsync(UNDO_WINDOW_SECONDS * 1000);
      expect(sentCalls.slice(before)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('undoes an approval and offers the three buttons again', async () => {
    vi.mocked(proposals.applyDecision).mockResolvedValueOnce({
      outcome: 'applied',
      state: 'pending',
      intentId: null,
    } as never);
    const data = encodeCallbackData(
      { proposalId: PROPOSAL, action: 'undo', nonce: mintNonce() },
      SIGNING_SECRET,
    );
    await post({
      callback_query: {
        id: 'cb-2',
        data,
        message: {
          message_id: 99,
          text: 'VOO is 12.4pp above your target weight\n\n\u2705 Approved \u2014 recorded in your ledger. No order was placed. (10:02)',
          chat: { id: CHAT },
        },
      },
    });

    expect(vi.mocked(proposals.applyDecision).mock.calls[0]![0].action).toBe('undo');
    expect(toast()).toContain('undone');
    const edit = sentCalls.find((call) => call.method === 'editMessageText');
    expect(buttonsOf(edit)).toEqual(['Approve', 'Reject', 'Snooze']);
    // Appended under the approval, not in place of it: both happened.
    const lines = String(edit!.body.text).split('\n');
    expect(lines.at(-2)).toContain('Approved');
    expect(lines.at(-1)).toContain('Approval undone');
  });

  it('mints fresh nonces for buttons it puts back', async () => {
    // The Approve that returns after an undo must not carry the nonce the first
    // approval already spent, or tapping it would be read as a replay.
    vi.mocked(proposals.applyDecision).mockResolvedValueOnce({
      outcome: 'applied',
      state: 'pending',
      intentId: null,
    } as never);
    const nonce = mintNonce();
    await post(
      callbackUpdate(
        encodeCallbackData({ proposalId: PROPOSAL, action: 'undo', nonce }, SIGNING_SECRET),
      ),
    );
    const edit = sentCalls.find((call) => call.method === 'editMessageText');
    const keyboard = (edit!.body.reply_markup as { inline_keyboard: { callback_data: string }[][] })
      .inline_keyboard.flat();
    const nonces = keyboard.map((button) => decodeCallbackData(button.callback_data, SIGNING_SECRET)!.nonce);
    expect(new Set(nonces).size).toBe(3);
    expect(nonces).not.toContain(nonce);
  });

  it('answers the tap before it rewrites the message', async () => {
    // The toast is what the user is waiting on - Telegram stops spinning the
    // button the moment it lands - and the edit must not delay it.
    const data = encodeCallbackData(
      { proposalId: PROPOSAL, action: 'approve', nonce: mintNonce() },
      SIGNING_SECRET,
    );
    await post(callbackUpdate(data));
    const methods = sentCalls.map((call) => call.method);
    expect(methods.indexOf('answerCallbackQuery')).toBeLessThan(
      methods.indexOf('editMessageText'),
    );
  });

  it('still answers 200 when the message cannot be rewritten', async () => {
    // The decision is already in the ledger. A failed edit is a cosmetic loss,
    // and a non-200 would earn a redelivery of a spent nonce.
    const data = encodeCallbackData(
      { proposalId: PROPOSAL, action: 'approve', nonce: mintNonce() },
      SIGNING_SECRET,
    );
    const response = await post(callbackUpdate(data));
    expect(response.status).toBe(200);
  });

  it('answers 200 even when applying the decision throws', async () => {
    // Anything else is retried by Telegram, and the retry re-delivers a
    // callback whose nonce is already spent.
    vi.mocked(proposals.applyDecision).mockRejectedValueOnce(new Error('database is down'));
    const data = encodeCallbackData(
      { proposalId: PROPOSAL, action: 'approve', nonce: mintNonce() },
      SIGNING_SECRET,
    );
    expect((await post(callbackUpdate(data))).status).toBe(200);
  });
});

describe('/start', () => {
  it('binds the chat when the link verifies', async () => {
    const { token } = encodeBindToken(USER, SIGNING_SECRET);
    await post(messageUpdate(`/start ${token}`));

    expect(queries.redeemTelegramBindToken).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER, chatId: String(CHAT) }),
    );
    expect(sentCalls[0]?.body.text).toContain('Connected');
  });

  it('refuses a link signed with the wrong secret', async () => {
    const { token } = encodeBindToken(USER, 'a-forged-secret-long-enough');
    await post(messageUpdate(`/start ${token}`));
    expect(queries.redeemTelegramBindToken).not.toHaveBeenCalled();
    expect(sentCalls[0]?.body.text).toContain('not valid');
  });

  it('refuses a second redemption of the same link', async () => {
    // Single-use is the primary key on the nonce; the route reports it.
    vi.mocked(queries.redeemTelegramBindToken).mockResolvedValueOnce({
      bound: false,
      reason: 'already_used',
    });
    const { token } = encodeBindToken(USER, SIGNING_SECRET);
    await post(messageUpdate(`/start ${token}`));
    expect(sentCalls[0]?.body.text).toContain('already been used');
  });

  it('refuses a chat already speaking for another account', async () => {
    vi.mocked(queries.redeemTelegramBindToken).mockResolvedValueOnce({
      bound: false,
      reason: 'chat_taken',
    });
    const { token } = encodeBindToken(USER, SIGNING_SECRET);
    await post(messageUpdate(`/start ${token}`));
    expect(sentCalls[0]?.body.text).toContain('another account');
  });

  it('refuses a link signed with the WEBHOOK secret rather than the signing key', async () => {
    /**
     * The hole this separation exists to close, and it was real: the first
     * version signed connect links with the webhook secret. That value is
     * shared with Telegram and rides in the header of every inbound request,
     * so anywhere TLS terminates it is plaintext a proxy log will capture -
     * and SINGLE_USER_ID defaults to a value published in this repository.
     * Anyone reading that header out of a log could therefore mint a link for
     * the account, bind their own chat, and approve its proposals.
     */
    const { token } = encodeBindToken(USER, WEBHOOK_SECRET);
    await post(messageUpdate(`/start ${token}`));

    expect(queries.redeemTelegramBindToken).not.toHaveBeenCalled();
    expect(sentCalls[0]?.body.text).toContain('not valid');
  });

  it('refuses a callback token presented as a connect link', async () => {
    // Both are signed with the same key now, so the domain tag is what keeps
    // one from passing as the other.
    const callbackToken = encodeCallbackData(
      { proposalId: PROPOSAL, action: 'approve', nonce: mintNonce() },
      SIGNING_SECRET,
    );
    await post(messageUpdate(`/start ${callbackToken}`));
    expect(queries.redeemTelegramBindToken).not.toHaveBeenCalled();
  });

  it('refuses a bare /start with no link', async () => {
    await post(messageUpdate('/start'));
    expect(queries.redeemTelegramBindToken).not.toHaveBeenCalled();
  });
});

describe('a chat whose user reads Hebrew', () => {
  beforeEach(() => {
    bound();
    vi.mocked(queries.getOrCreateUserSettings).mockResolvedValue({
      notify_severity: 'high',
      muted_until: null,
      language: 'he',
    } as never);
  });
  // `clearAllMocks` keeps an implementation, so the Hebrew user would outlive this block.
  afterEach(() => {
    vi.mocked(queries.getOrCreateUserSettings).mockResolvedValue({
      notify_severity: 'high',
      muted_until: null,
      language: 'en',
    } as never);
  });

  it('answers a tap, and labels the buttons it leaves, in Hebrew', async () => {
    const data = encodeCallbackData(
      { proposalId: PROPOSAL, action: 'approve', nonce: mintNonce() },
      SIGNING_SECRET,
    );
    await post(callbackUpdate(data));

    expect(toast()).toBe(MESSAGES.he.decisionReplies.approved);
    expect(buttonsOf(sentCalls.find((call) => call.method === 'editMessageReplyMarkup'))).toEqual([
      MESSAGES.he.working.approve,
    ]);
    const edited = sentCalls.find((call) => call.method === 'editMessageText');
    expect(String(edited?.body.text)).toContain(MESSAGES.he.outcomeLines.approved);
    expect(buttonsOf(edited)).toEqual([MESSAGES.he.undoButton]);
  });

  it('lists what is waiting by each proposal’s Hebrew headline', async () => {
    vi.mocked(queries.listProposals).mockResolvedValueOnce([
      {
        id: PROPOSAL,
        state: 'pending',
        expires_at: new Date(Date.now() + 3_600_000),
        snoozed_until: null,
        headline: 'VOO is 12.3 percentage points below its 25.0% target',
        explanation: null,
        localized: { he: { headline: 'משקל \u2066VOO\u2069 נמוך', explanation: '' } },
      },
    ] as never);
    await post(messageUpdate('/pending'));
    expect(sentCalls[0]?.body.text).toBe('• משקל \u2066VOO\u2069 נמוך');
  });

  it('names the alert floor in Hebrew', async () => {
    await post(messageUpdate('/portfolio'));
    expect(sentCalls[0]?.body.text).toBe(MESSAGES.he.alertingFrom('גבוה'));
  });

  it('still answers an unbound chat in English: nobody’s language is known', async () => {
    vi.mocked(queries.findTelegramBindingByChat).mockResolvedValue(null);
    await post(callbackUpdate('not-a-signed-payload'));
    expect(toast()).toBe(MESSAGES.en.buttonInvalid);
  });
});

describe('commands from a bound chat', () => {
  beforeEach(() => bound());

  it('/stop disconnects and says the portfolio is still watched', async () => {
    // "Disconnected" could be read as "stopped watching my portfolio", and it
    // does not mean that.
    await post(messageUpdate('/stop'));
    expect(queries.deleteTelegramBinding).toHaveBeenCalledWith(USER);
    expect(sentCalls[0]?.body.text).toContain('still being watched');
  });

  it('/mute with no argument mutes for the default window', async () => {
    await post(messageUpdate('/mute'));
    expect(queries.muteUntil).toHaveBeenCalledWith(USER, expect.any(Date));
  });

  it('/mute 2h mutes for the stated window', async () => {
    await post(messageUpdate('/mute 2h'));
    const [, until] = vi.mocked(queries.muteUntil).mock.calls[0]!;
    const hours = (until!.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(1.9);
    expect(hours).toBeLessThan(2.1);
  });

  it('/mute with nonsense explains instead of muting forever', async () => {
    await post(messageUpdate('/mute soon'));
    expect(queries.muteUntil).not.toHaveBeenCalled();
    expect(sentCalls[0]?.body.text).toContain('/mute 2h');
  });

  it('/pending says so when nothing is waiting', async () => {
    await post(messageUpdate('/pending'));
    expect(sentCalls[0]?.body.text).toContain('Nothing waiting');
  });

  it('/pending leaves out a proposal whose deadline has passed', async () => {
    // The stored state still says pending; the state machine disagrees, and the
    // bot must not offer a live-looking item on a dead question.
    vi.mocked(queries.listProposals).mockResolvedValueOnce([
      {
        id: PROPOSAL,
        state: 'pending',
        expires_at: new Date(Date.now() - 60_000),
        snoozed_until: null,
        headline: 'a dead proposal',
      },
    ] as never);
    await post(messageUpdate('/pending'));
    expect(sentCalls[0]?.body.text).toContain('Nothing waiting');
  });

  it('an unknown command lists the ones that exist', async () => {
    await post(messageUpdate('/teapot'));
    expect(sentCalls[0]?.body.text).toContain('/portfolio');
  });
});

describe('malformed updates', () => {
  it.each([
    ['empty object', {}],
    ['null body', null],
    ['a message with no text', { message: { chat: { id: CHAT } } }],
    ['a callback with no data', { callback_query: { id: 'x', message: { chat: { id: CHAT } } } }],
    ['an unrecognised update kind', { poll_answer: { option_ids: [1] } }],
  ])('answers 200 to %s rather than inviting a redelivery loop', async (_label, body) => {
    expect((await post(body)).status).toBe(200);
  });
});
