/**
 * Deciding from `/pending` (M11 B, D282): the list opens a proposal in place,
 * drawn as its alert is, with the alert's own signed buttons - and a decision
 * made there is the alert's decision, through the same handler, keeping the
 * way back to the list.
 *
 * No network: the Telegram client records what it would send.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER = '00000000-0000-0000-0000-000000000001';
const TRADE = '11111111-0000-0000-0000-000000000001';
const OBSERVATION = '11111111-0000-0000-0000-000000000002';
const CHAT = 987654321;
const MESSAGE_ID = 42;
const SIGNING_SECRET = 'a-signing-secret-long-enough';

function proposalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TRADE,
    user_id: USER,
    observation_id: 'o-1',
    kind: 'buy',
    payload: {},
    state: 'pending',
    expires_at: new Date(Date.now() + 3_600_000),
    snoozed_until: null,
    decided_at: null,
    decided_via: null,
    created_at: new Date(),
    severity: 'notable',
    subject_ref: null,
    headline: 'Tech Stocks proposes to buy 3 AAPL at 232.14',
    explanation: 'Earnings momentum.',
    localized: {},
    evidence: {},
    agent_id: 'a-1',
    agent_name: 'Tech Stocks',
    agent_is_primary: false,
    scan_id: 's-1',
    scan_tool_calls: [],
    ...overrides,
  };
}

let row: Record<string, unknown> | null = proposalRow();
let language = 'en';

vi.mock('../src/db/pool.js', () => ({
  queryOne: vi.fn(async () => null),
  query: vi.fn(async () => []),
  transaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({})),
  initPool: vi.fn(),
  getPool: vi.fn(),
  closePool: vi.fn(),
}));

vi.mock('../src/db/queries.js', () => ({
  findTelegramBindingByChat: vi.fn(async () => ({ user_id: USER, chat_id: String(CHAT), legal_accepted: true })),
  getOrCreateUserSettings: vi.fn(async () => ({ language, notify_severity: 'high', muted_until: null })),
  getUser: vi.fn(async () => ({ id: USER, role: 'user', base_currency: 'USD', timezone: 'Asia/Jerusalem' })),
  // Scoped by user, as the SQL is: another user's proposal is not found.
  findProposal: vi.fn(async (userId: string, id: string) => (userId === USER && id === (row?.id ?? '') ? row : null)),
  listProposals: vi.fn(async () => (row === null ? [] : [row])),
}));

vi.mock('../src/services/proposals.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/proposals.js')>('../src/services/proposals.js');
  return { ...actual, applyDecision: vi.fn(async () => ({ outcome: 'applied', state: 'rejected' })) };
});

const queries = await import('../src/db/queries.js');
const proposals = await import('../src/services/proposals.js');
const { handleTelegramUpdate, openedFromPending } = await import('../src/telegram/updates.js');
const { TelegramNotifier } = await import('../src/telegram/client.js');
const { MESSAGES } = await import('../src/notify/messages.js');
const { loadConfig, resetConfigForTests } = await import('../src/config.js');
const { createFakeAi } = await import('./fakeAi.js');
const { memoryRateLimits } = await import('../src/http/rateLimits.js');
const { decodeMenuData, encodeMenuData, MENU_PREFIX } = await import('../src/telegram/menuData.js');
const { decodeCallbackData, encodeCallbackData, mintNonce } = await import('../src/telegram/callbackToken.js');
const { PENDING_BUTTON_CHARS, PENDING_LIST_LIMIT, clip } = await import('../src/telegram/menu.js');

const ENV = {
  APP_ENV: 'test',
  LOG_LEVEL: 'error',
  SESSION_SECRET: 'test-session-secret-value',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  AI_SERVICE_URL: 'http://ai-service:8000',
  INTERNAL_API_KEY: 'internal-test-key',
  TELEGRAM_BOT_TOKEN: 'bot-token',
  TELEGRAM_SIGNING_SECRET: SIGNING_SECRET,
} as unknown as NodeJS.ProcessEnv;

let sent: { method: string; body: Record<string, unknown> }[] = [];

function deps() {
  resetConfigForTests();
  const notifier = new TelegramNotifier({
    botToken: 'bot-token',
    callbackSecret: SIGNING_SECRET,
    resolveChatId: async () => String(CHAT),
    fetchImpl: async (url, init) => {
      sent.push({ method: url.split('/').pop() as string, body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response('{"ok":true}', { status: 200 });
    },
  });
  return { config: loadConfig(ENV), notifier, ai: createFakeAi() as never, rateLimits: memoryRateLimits() };
}

type Button = { text: string; callback_data?: string; url?: string };
const calls = (method: string) => sent.filter((call) => call.method === method).map((call) => call.body);
const toast = () => calls('answerCallbackQuery').at(-1)?.text;
const lastEdit = () => sent.filter((call) => call.method.startsWith('editMessage')).at(-1)?.body;
const buttonsOf = (body: Record<string, unknown> | undefined): Button[] =>
  ((body?.reply_markup as { inline_keyboard?: Button[][] } | undefined)?.inline_keyboard ?? []).flat();
const PENDING_BUTTON = { text: '⬅️ Pending', callback_data: encodeMenuData({ view: 'pending' }) };

const tapUpdate = (data: string, markup?: Button[][]) => ({
  callback_query: {
    id: 'cb-1',
    data,
    message: {
      message_id: MESSAGE_ID,
      text: 'the view',
      chat: { id: CHAT, type: 'private' },
      ...(markup === undefined ? {} : { reply_markup: { inline_keyboard: markup } }),
    },
  },
});

async function tap(data: string, markup?: Button[][]) {
  await handleTelegramUpdate(deps(), tapUpdate(data, markup));
  await vi.waitFor(() => expect(calls('answerCallbackQuery')).not.toHaveLength(0));
}

beforeEach(() => {
  sent = [];
  row = proposalRow();
  language = 'en';
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('the list', () => {
  it('each open proposal is a button that opens it, its label cut to fit a phone', async () => {
    row = proposalRow({ headline: 'An agent proposes something with a headline far longer than any phone button holds' });
    await handleTelegramUpdate(deps(), { message: { chat: { id: CHAT, type: 'private' }, text: '/pending' } });
    const [first] = buttonsOf(calls('sendMessage')[0]);
    expect(decodeMenuData(first!.callback_data!)).toEqual({ view: 'proposal', proposalId: TRADE });
    expect(first!.text.length).toBeLessThanOrEqual(PENDING_BUTTON_CHARS);
    expect(first!.text.startsWith('1. ')).toBe(true);
  });
});

describe('the list, at its edges', () => {
  it('stale rows past their deadline do not crowd out live ones', async () => {
    const stale = Array.from({ length: PENDING_LIST_LIMIT }, (_, i) =>
      proposalRow({ id: `22222222-0000-0000-0000-${String(i).padStart(12, '0')}`, expires_at: new Date(Date.now() - 60_000) }),
    );
    vi.mocked(queries.listProposals).mockResolvedValueOnce([...stale, proposalRow()] as never);
    await handleTelegramUpdate(deps(), { message: { chat: { id: CHAT, type: 'private' }, text: '/pending' } });
    const opened = buttonsOf(calls('sendMessage')[0]).map((b) => decodeMenuData(b.callback_data!));
    expect(opened).toContainEqual({ view: 'proposal', proposalId: TRADE });
  });

  it('a label cut inside a direction isolate closes it', () => {
    const cut = clip(`1. \u2068${'א'.repeat(PENDING_BUTTON_CHARS)}\u2069 מציע`, PENDING_BUTTON_CHARS);
    const opened = (cut.match(/[\u2066-\u2068]/g) ?? []).length;
    expect((cut.match(/\u2069/g) ?? []).length).toBe(opened);
  });

  it('a label is cut by characters: an emoji is never split', () => {
    const text = `${'a'.repeat(PENDING_BUTTON_CHARS - 2)}📈📈📈`;
    const cut = clip(text, PENDING_BUTTON_CHARS);
    expect(Array.from(cut)).toHaveLength(PENDING_BUTTON_CHARS);
    expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
});

describe('a proposal opened from the list', () => {
  it('a trade: its words, what its scan checked, when it closes; Approve and Reject, and the way back', async () => {
    await tap(encodeMenuData({ view: 'proposal', proposalId: TRADE }));
    expect(queries.findProposal).toHaveBeenCalledWith(USER, TRADE);
    const edit = lastEdit();
    expect(edit).toMatchObject({ message_id: MESSAGE_ID });
    const text = String(edit?.text);
    expect(text).toContain('Tech Stocks proposes to buy 3 AAPL at 232.14');
    expect(text).toContain('Earnings momentum.');
    expect(text).toContain('Checked:');
    expect(text).toMatch(/Open until .*\d{2}:\d{2}\./);
    const buttons = buttonsOf(edit);
    const decisions = buttons.map((b) => (b.callback_data ? decodeCallbackData(b.callback_data, SIGNING_SECRET) : null));
    expect(decisions.filter((d) => d !== null).map((d) => [d!.proposalId, d!.action])).toEqual([
      [TRADE, 'approve'],
      [TRADE, 'reject'],
    ]);
    expect(decodeMenuData(buttons.at(-1)!.callback_data!)).toEqual({ view: 'pending' });
  });

  it('an observation: Approve, Reject and Snooze', async () => {
    row = proposalRow({ id: OBSERVATION, kind: 'rebalance', scan_id: null, scan_tool_calls: null });
    await tap(encodeMenuData({ view: 'proposal', proposalId: OBSERVATION }));
    const actions = buttonsOf(lastEdit())
      .map((b) => (b.callback_data ? decodeCallbackData(b.callback_data, SIGNING_SECRET) : null))
      .filter((d) => d !== null)
      .map((d) => d!.action);
    expect(actions).toEqual(['approve', 'reject', 'snooze']);
    expect(String(lastEdit()?.text)).not.toContain('Checked:');
    expect(String(lastEdit()?.text)).toMatch(/As of \d{2}:\d{2}/);
    expect(decodeMenuData(buttonsOf(lastEdit()).at(-1)!.callback_data!)).toEqual({ view: 'pending' });
  });

  it('a snoozed one says until when, and that it can still be decided now', async () => {
    row = proposalRow({ state: 'snoozed', snoozed_until: new Date(Date.now() + 1_800_000) });
    await tap(encodeMenuData({ view: 'proposal', proposalId: TRADE }));
    expect(String(lastEdit()?.text)).toMatch(/Snoozed until .*\d{2}:\d{2}; you can still decide it now\./);
  });

  it.each([
    ['decided since the list was drawn', () => proposalRow({ state: 'rejected', decided_at: new Date() })],
    ['past its deadline, still stored pending', () => proposalRow({ expires_at: new Date(Date.now() - 60_000) })],
    ["gone, or somebody else's", () => null],
  ])('%s: the list is drawn again, and says so', async (_label, make) => {
    row = make();
    await tap(encodeMenuData({ view: 'proposal', proposalId: TRADE }));
    expect(toast()).toBe(MESSAGES.en.menu.proposal.notOpen);
    expect(buttonsOf(lastEdit()).some((b) => b.callback_data && decodeCallbackData(b.callback_data, SIGNING_SECRET))).toBe(false);
    // The list, drawn again: its Refresh and Menu.
    const taps = buttonsOf(lastEdit()).map((b) => decodeMenuData(b.callback_data ?? ''));
    expect(taps.slice(-2)).toEqual([{ view: 'pending' }, { view: 'help' }]);
  });
});

describe('in Hebrew', () => {
  it('the proposal in its Hebrew words, times isolated, the way back pointing the reader’s way', async () => {
    language = 'he';
    row = proposalRow({ localized: { he: { headline: 'הסוכן מציע לקנות', explanation: 'מומנטום ברווחים.' } } });
    await tap(encodeMenuData({ view: 'proposal', proposalId: TRADE }));
    const text = String(lastEdit()?.text);
    expect(text).toContain('הסוכן מציע לקנות');
    expect(text).toContain('מומנטום ברווחים.');
    expect(text).toMatch(/פתוחה עד \u2068[^\u2069]*\u2069\./);
    expect(buttonsOf(lastEdit()).at(-1)!.text).toBe(MESSAGES.he.menu.buttons.backToPending);
  });
});

describe('deciding there is the alert’s decision', () => {
  const reject = () => encodeCallbackData({ proposalId: TRADE, action: 'reject', nonce: mintNonce() }, SIGNING_SECRET);

  it('the same transition, and the decided message keeps its way back to the list', async () => {
    await tap(reject(), [[{ text: 'Reject', callback_data: 'x' }], [PENDING_BUTTON]]);
    expect(proposals.applyDecision).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER, proposalId: TRADE, action: 'reject', surface: 'telegram' }),
    );
    const back = buttonsOf(lastEdit()).at(-1)!;
    expect(decodeMenuData(back.callback_data!)).toEqual({ view: 'pending' });
  });

  it('a snooze there keeps the way back, as every redraw does', async () => {
    vi.mocked(proposals.applyDecision).mockResolvedValueOnce({ outcome: 'applied', state: 'snoozed' } as never);
    const snooze = encodeCallbackData({ proposalId: TRADE, action: 'snooze', nonce: mintNonce() }, SIGNING_SECRET);
    await tap(snooze, [[{ text: 'Snooze', callback_data: 'x' }], [PENDING_BUTTON]]);
    expect(decodeMenuData(buttonsOf(lastEdit()).at(-1)!.callback_data!)).toEqual({ view: 'pending' });
  });

  it('an alert decided where it arrived gains no way back: it was never in the list', async () => {
    await tap(reject(), [[{ text: 'Reject', callback_data: 'x' }]]);
    expect(buttonsOf(lastEdit()).some((b) => b.callback_data?.startsWith(MENU_PREFIX))).toBe(false);
  });

  it('only the list’s own button marks a message as opened from it', () => {
    expect(openedFromPending({ reply_markup: { inline_keyboard: [[PENDING_BUTTON]] } })).toBe(true);
    expect(openedFromPending({ reply_markup: { inline_keyboard: [[{ callback_data: encodeMenuData({ view: 'help' }) }]] } })).toBe(false);
    expect(openedFromPending({})).toBe(false);
  });
});
