/**
 * The bot's menu (M11 slice A1, D268-D271): the read-only views, the buttons
 * that move between them by editing one message, and the `/` command list.
 *
 * The menu's buttons are unsigned, so the tests that matter most are the ones
 * about whose data a tap reads: always the tapping chat's user, never one the
 * button names.
 *
 * No network: the Telegram client records what it would send, and the AI
 * client is the fixture-priced fake.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER = '00000000-0000-0000-0000-000000000001';
const PRIMARY = '90000000-0000-0000-0000-000000000001';
const AGENT = '90000000-0000-0000-0000-0000000000a1';
const PAUSED = '90000000-0000-0000-0000-0000000000a2';
const ARCHIVED = '90000000-0000-0000-0000-0000000000a3';
const CHAT = 987654321;
const MESSAGE_ID = 42;
const SIGNING_SECRET = 'a-signing-secret-long-enough';

function agentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT,
    slug: 'tech',
    name: 'Tech Stocks',
    persona: 'Large technology companies.',
    is_primary: false,
    budget_minor: '1000000',
    currency: 'USD',
    state: 'active',
    created_at: new Date('2026-10-05T10:00:00Z'),
    holdings_count: 1,
    cash_minor: '930358',
    llm_budget_micro_usd: '500000',
    llm_spent_today_micro_usd: '72000',
    scan_every_hours: 4,
    scan_pre_open: true,
    scan_post_close: false,
    max_decisions: 2,
    running_scan: null,
    agent_scan_cost_micro_usd: null,
    installation_scan_cost_micro_usd: null,
    risk_level: null,
    horizon: null,
    thesis_style: null,
    max_position_bps: null,
    cash_buffer_bps: null,
    max_holdings: null,
    allow_etfs: true,
    market_caps: [],
    sectors: [],
    industries: [],
    etf_categories: [],
    blocked_symbols: [],
    ...overrides,
  };
}

function holding(symbol: string, quantity: string, cost: string | null = '20000') {
  return {
    id: `h-${symbol}`,
    user_id: USER,
    instrument_id: `i-${symbol}`,
    quantity,
    cost_basis_minor: cost,
    currency: 'USD',
    opened_at: null,
    notes: null,
    symbol,
    name: symbol,
    asset_class: 'equity',
    exchange: 'NMS',
    instrument_currency: 'USD',
  };
}

function scanRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 's-1',
    trigger: 'schedule',
    started_at: new Date(Date.now() - 3_600_000),
    finished_at: new Date(Date.now() - 3_540_000),
    outcome: 'trade',
    steps: 6,
    cost_micro_usd: '36000',
    model: 'google/gemini-2.5-flash',
    answer: {
      trades: [
        { decision: 'buy', symbol: 'AAPL', quantity: '3', thesis: 'Earnings momentum.', refused: false },
        { decision: 'sell', symbol: 'VOO', quantity: '1', refused: true, problems: ['not held'] },
      ],
    },
    error: null,
    proposals: [
      {
        id: 'p-1',
        symbol: 'AAPL',
        state: 'pending',
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        snoozed_until: null,
        decided_at: null,
        fill_id: null,
      },
    ],
    ...overrides,
  };
}

let settings: Record<string, unknown> = {};

vi.mock('../src/db/pool.js', () => ({
  queryOne: vi.fn(async () => null),
  query: vi.fn(async () => []),
  transaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({})),
  initPool: vi.fn(),
  getPool: vi.fn(),
  closePool: vi.fn(),
}));

vi.mock('../src/db/queries.js', () => ({
  findTelegramBindingByChat: vi.fn(async () => ({ user_id: USER, chat_id: String(CHAT) })),
  findTelegramBindingByUser: vi.fn(async () => null),
  redeemTelegramBindToken: vi.fn(async () => ({ bound: true })),
  deleteTelegramBinding: vi.fn(async () => true),
  setTelegramConversation: vi.fn(async () => undefined),
  getOrCreateUserSettings: vi.fn(async () => settings),
  getUser: vi.fn(async () => ({ id: USER, base_currency: 'USD', timezone: 'Asia/Jerusalem' })),
  muteUntil: vi.fn(async () => undefined),
  primaryAgentId: vi.fn(async () => PRIMARY),
  listHoldings: vi.fn(async () => []),
  listProposals: vi.fn(async () => []),
  listAgents: vi.fn(async () => []),
  getAgent: vi.fn(async () => null),
  listAgentScans: vi.fn(async () => []),
  findProposal: vi.fn(async () => null),
}));

const queries = await import('../src/db/queries.js');
const { handleTelegramUpdate } = await import('../src/telegram/updates.js');
const { TelegramNotifier } = await import('../src/telegram/client.js');
const { MESSAGES } = await import('../src/notify/messages.js');
const { loadConfig, resetConfigForTests } = await import('../src/config.js');
const { createFakeAi } = await import('./fakeAi.js');
const { decodeMenuData, encodeMenuData, QUICK_MUTE_HOURS, MENU_PREFIX } = await import('../src/telegram/menuData.js');
const { MAX_CALLBACK_DATA_BYTES, decodeCallbackData, encodeCallbackData, mintNonce, BUSY_CALLBACK_DATA } = await import(
  '../src/telegram/callbackToken.js'
);
const { BOT_COMMANDS, MAX_COMMAND_DESCRIPTION_CHARS, registerBotCommands } = await import(
  '../src/telegram/commandMenu.js'
);
const { PENDING_LIST_LIMIT, microUsd, slotsOfSchedule } = await import('../src/telegram/menu.js');
const { scansPerDay } = await import('@traders/shared');
const { scheduleOf } = await import('../src/services/scanSchedule.js');
const { isolated } = await import('../src/notify/messages.js');

const ENV = {
  APP_ENV: 'test',
  LOG_LEVEL: 'error',
  SESSION_SECRET: 'test-session-secret-value',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  AI_SERVICE_URL: 'http://ai-service:8000',
  INTERNAL_API_KEY: 'internal-test-key',
  TELEGRAM_BOT_TOKEN: 'bot-token',
  TELEGRAM_SIGNING_SECRET: SIGNING_SECRET,
  ENABLE_SCHEDULED_SCANS: 'true',
} as unknown as NodeJS.ProcessEnv;

let sent: { method: string; body: Record<string, unknown> }[] = [];
/** Telegram's refusal of an edit, if any: a Refresh in the same minute is "message is not modified". */
let editRefusal: string | null = null;
/** Telegram's answer to `setMyCommands`. */
let commandsStatus = 200;

/** A trading session two days out, so the agent's next scan has somewhere to land. */
function sessionAhead() {
  const day = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  return { day, opens_at: `${day}T13:30:00Z`, closes_at: `${day}T20:00:00Z`, early_close: false };
}

function deps(webBaseUrl: string | null = null) {
  resetConfigForTests();
  const notifier = new TelegramNotifier({
    botToken: 'bot-token',
    callbackSecret: SIGNING_SECRET,
    resolveChatId: async () => String(CHAT),
    webBaseUrl,
    fetchImpl: async (url, init) => {
      const method = url.split('/').pop() as string;
      sent.push({ method, body: JSON.parse(String(init?.body ?? '{}')) });
      if (method === 'editMessageText' && editRefusal !== null) {
        return new Response(JSON.stringify({ ok: false, description: editRefusal }), { status: 400 });
      }
      if (method === 'setMyCommands' && commandsStatus !== 200) {
        return new Response('{"ok":false,"description":"Bad Request"}', { status: commandsStatus });
      }
      return new Response('{"ok":true}', { status: 200 });
    },
  });
  const ai = { ...createFakeAi({ unpriceable: ['ACME'] }), marketSessions: vi.fn(async () => ({ sessions: [sessionAhead()] })) };
  return { config: loadConfig(ENV), notifier, ai: ai as never };
}

const command = (text: string) => ({ message: { chat: { id: CHAT, type: 'private' }, text } });
const tap = (data: string, chat = CHAT) => ({
  callback_query: { id: 'cb-1', data, message: { message_id: MESSAGE_ID, text: 'old view', chat: { id: chat, type: 'private' } } },
});

/**
 * A tap is handled off the poller (`menu.ts`), and its answer is the last thing
 * it sends: wait for that.
 */
async function tapAndSettle(update: unknown, d = deps()) {
  await handleTelegramUpdate(d, update);
  await vi.waitFor(() => expect(calls('answerCallbackQuery')).not.toHaveLength(0));
}

const calls = (method: string) => sent.filter((call) => call.method === method).map((call) => call.body);
const lastText = () => String((calls('editMessageText').at(-1) ?? calls('sendMessage').at(-1))?.text);
const toast = () => calls('answerCallbackQuery').at(-1)?.text;

type Button = { text: string; callback_data?: string; url?: string };
function buttonsOf(body: Record<string, unknown> | undefined): Button[] {
  const markup = body?.reply_markup as { inline_keyboard?: Button[][] } | undefined;
  return (markup?.inline_keyboard ?? []).flat();
}
const lastButtons = () => buttonsOf(calls('editMessageText').at(-1) ?? calls('sendMessage').at(-1));
const tapsOf = (buttons: Button[]) => buttons.filter((b) => b.callback_data).map((b) => decodeMenuData(b.callback_data!));

beforeEach(() => {
  sent = [];
  editRefusal = null;
  commandsStatus = 200;
  settings = {
    language: 'en',
    notify_severity: 'high',
    quiet_hours_start: '22:00',
    quiet_hours_end: '07:00',
    muted_until: null,
  };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('the button data', () => {
  const taps = [
    { view: 'help' },
    { view: 'portfolio' },
    { view: 'agents' },
    { view: 'status' },
    { view: 'pending' },
    { view: 'agent', agentId: AGENT },
    { view: 'agentLog', agentId: AGENT },
    { view: 'mute', hours: 0 },
    ...QUICK_MUTE_HOURS.map((hours) => ({ view: 'mute' as const, hours })),
  ] as const;

  it.each(taps)('round-trips %o inside Telegram’s limit', (menuTap) => {
    const data = encodeMenuData(menuTap);
    expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(MAX_CALLBACK_DATA_BYTES);
    expect(decodeMenuData(data)).toEqual(menuTap);
  });

  it.each([
    ['an unknown view', `${MENU_PREFIX}z`],
    ['a plain view with a tail', `${MENU_PREFIX}pX`],
    ['an agent id cut short', `${MENU_PREFIX}g${'A'.repeat(21)}`],
    ['an agent id that is not canonical base64url', `${MENU_PREFIX}g${'A'.repeat(21)}B`],
    ['a mute nobody offered', `${MENU_PREFIX}u24`],
    ['a mute spelled with a leading zero', `${MENU_PREFIX}u04`],
    ['no prefix', 'p'],
  ])('refuses %s', (_label, data) => {
    expect(decodeMenuData(data)).toBeNull();
  });

  it('is never read as a signed proposal button, nor the busy placeholder as menu data', () => {
    expect(decodeCallbackData(encodeMenuData({ view: 'agent', agentId: AGENT }), SIGNING_SECRET)).toBeNull();
    expect(decodeMenuData(BUSY_CALLBACK_DATA)).toBeNull();
  });
});

describe('commands send a view', () => {
  it('/help offers the four quick actions', async () => {
    await handleTelegramUpdate(deps(), command('/help'));
    expect(calls('sendMessage')).toHaveLength(1);
    expect(lastText()).toBe(MESSAGES.en.menu.help);
    expect(tapsOf(lastButtons())).toEqual([
      { view: 'portfolio' },
      { view: 'agents' },
      { view: 'status' },
      { view: 'pending' },
    ]);
  });

  it('a bare /start in a connected chat shows the help', async () => {
    await handleTelegramUpdate(deps(), command('/start'));
    expect(lastText()).toBe(MESSAGES.en.menu.help);
  });

  it('a bare /start in a chat that is not connected says how to connect', async () => {
    vi.mocked(queries.findTelegramBindingByChat).mockResolvedValueOnce(null);
    await handleTelegramUpdate(deps(), command('/start'));
    expect(lastText()).toBe(MESSAGES.en.linkInvalid);
  });

  it('a command chosen from the menu in a group carries the bot’s name, and still works', async () => {
    await handleTelegramUpdate(deps(), command('/help@traders_test_bot'));
    expect(lastText()).toBe(MESSAGES.en.menu.help);
  });

  it('/portfolio shows the real portfolio’s value and today’s change, and names what has no price', async () => {
    vi.mocked(queries.listHoldings).mockResolvedValueOnce([
      holding('AAPL', '3.000000000000000000'),
      holding('ACME', '10.000000000000000000'),
    ] as never);
    await handleTelegramUpdate(deps(), command('/portfolio'));

    // The real portfolio only: the primary agent's holdings.
    expect(queries.listHoldings).toHaveBeenCalledWith(USER, PRIMARY);
    const text = lastText();
    // AAPL: 3 x $232.14 = $696.42; the previous close 3 x $229.79 = $689.37.
    expect(text).toContain(MESSAGES.en.menu.portfolio.value('$696.42'));
    expect(text).toContain(MESSAGES.en.menu.portfolio.today('+$7.05', '+1.02%'));
    expect(text).toContain(MESSAGES.en.menu.portfolio.holdings(2, 1));
    expect(text).toContain(MESSAGES.en.menu.portfolio.unpriced(['ACME']));
    expect(text).toContain(MESSAGES.en.menu.portfolio.agentsApart);
    expect(text).toMatch(/As of \d{2}:\d{2}/);
    expect(tapsOf(lastButtons())).toEqual([{ view: 'portfolio' }, { view: 'help' }]);
  });

  it('/portfolio with no holdings says so instead of a $0.00 value', async () => {
    await handleTelegramUpdate(deps(), command('/portfolio'));
    expect(lastText()).toContain(MESSAGES.en.menu.portfolio.empty);
    expect(lastText()).not.toContain('$0.00');
  });

  it('/status offers the quick mutes, and Unmute only while muted', async () => {
    await handleTelegramUpdate(deps(), command('/status'));
    expect(lastText()).toContain(MESSAGES.en.menu.status.notMuted);
    expect(tapsOf(lastButtons())).toEqual([
      ...QUICK_MUTE_HOURS.map((hours) => ({ view: 'mute', hours })),
      { view: 'status' },
      { view: 'help' },
    ]);

    sent = [];
    settings = { ...settings, muted_until: new Date(Date.now() + 3_600_000) };
    await handleTelegramUpdate(deps(), command('/status'));
    expect(lastText()).toMatch(/Muted until \d{2}:\d{2}/);
    expect(tapsOf(lastButtons())).toContainEqual({ view: 'mute', hours: 0 });
  });

  it('/pending stays a read-only list: headlines, a snoozed one marked, no decision buttons', async () => {
    const proposal = (id: string, headline: string, overrides: Record<string, unknown> = {}) => ({
      id,
      state: 'pending',
      expires_at: new Date(Date.now() + 3_600_000),
      snoozed_until: null,
      decided_at: null,
      headline,
      explanation: null,
      ...overrides,
    });
    vi.mocked(queries.listProposals).mockResolvedValueOnce([
      proposal('11111111-0000-0000-0000-000000000001', 'VOO is above its target'),
      proposal('11111111-0000-0000-0000-000000000002', 'NVDA fell 7%', {
        state: 'snoozed',
        snoozed_until: new Date(Date.now() + 1_800_000),
      }),
      proposal('11111111-0000-0000-0000-000000000003', 'An expired one', { expires_at: new Date(Date.now() - 60_000) }),
    ] as never);
    await handleTelegramUpdate(deps(), command('/pending'));

    expect(queries.listProposals).toHaveBeenCalledWith(USER, { open: true, limit: PENDING_LIST_LIMIT });
    const text = lastText();
    expect(text).toContain('• VOO is above its target\n');
    expect(text).toContain(`• NVDA fell 7% (${MESSAGES.en.menu.pending.states.snoozed})`);
    expect(text).not.toContain('An expired one');
    // Every button is a menu button: nothing here decides a proposal.
    expect(lastButtons().every((b) => b.callback_data !== undefined && decodeMenuData(b.callback_data) !== null)).toBe(true);
    expect(tapsOf(lastButtons())).toEqual([{ view: 'pending' }, { view: 'help' }]);
  });

  it('/agents lists the simulated agents that are not archived, each a button to its view', async () => {
    vi.mocked(queries.listAgents).mockResolvedValueOnce([
      agentRow({ id: PRIMARY, is_primary: true, name: 'Real portfolio' }),
      agentRow(),
      agentRow({ id: PAUSED, name: 'Dividends', state: 'paused', scan_every_hours: null, scan_pre_open: false }),
      agentRow({ id: ARCHIVED, name: 'Old', state: 'archived' }),
    ] as never);
    await handleTelegramUpdate(deps(), command('/agents'));

    const buttons = lastButtons();
    expect(buttons.map((b) => b.text).slice(0, 2)).toEqual([
      `▶️ ${isolated('Tech Stocks')} · ${MESSAGES.en.menu.agents.scansADay(scansPerDay(scheduleOf(agentRow() as never)))}`,
      `⏸ ${isolated('Dividends')} · ${MESSAGES.en.menu.agents.scansADay(0)}`,
    ]);
    expect(tapsOf(buttons).slice(0, 2)).toEqual([
      { view: 'agent', agentId: AGENT },
      { view: 'agent', agentId: PAUSED },
    ]);
    expect(buttons.map((b) => b.text).join()).not.toMatch(/Real portfolio|Old/);
  });

  it('/unmute turns alerts back on', async () => {
    await handleTelegramUpdate(deps(), command('/unmute'));
    expect(queries.muteUntil).toHaveBeenCalledWith(USER, null);
    expect(lastText()).toBe(MESSAGES.en.unmuted);
  });

  it('/mute says until when in the user’s own clock, not as an ISO timestamp', async () => {
    await handleTelegramUpdate(deps(), command('/mute 2h'));
    expect(lastText()).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(lastText()).toMatch(/^Muted until .*\d{2}:\d{2}\./);
  });
});

describe('more of each view', () => {
  it('/help links to the app when the installation has a public address', async () => {
    await handleTelegramUpdate(deps('https://traders.example.com'), command('/help'));
    expect(lastButtons().at(-1)).toEqual({ text: MESSAGES.en.openInApp, url: 'https://traders.example.com' });
  });

  it('today’s change is "not known" without a previous close, never a guessed zero', async () => {
    vi.mocked(queries.listHoldings).mockResolvedValueOnce([holding('ACME', '10.000000000000000000')] as never);
    await handleTelegramUpdate(deps(), command('/portfolio'));
    expect(lastText()).toContain(MESSAGES.en.menu.portfolio.todayUnknown);
  });

  it('/status names the quiet hours', async () => {
    await handleTelegramUpdate(deps(), command('/status'));
    expect(lastText()).toContain(MESSAGES.en.menu.status.quietHours('22:00', '07:00'));
  });

  it.each([1, 2, 3, 4, 5, 6])('names the slots the scheduler runs, every %ih', (everyHours) => {
    const row = { scan_every_hours: everyHours, scan_pre_open: true, scan_post_close: true };
    const slots = slotsOfSchedule(row);
    expect(slots[0]).toBe('pre_open');
    expect(slots.at(-1)).toBe('post_close');
    expect(slots.length).toBe(scansPerDay(scheduleOf(row as never)));
  });
});

describe('a tap edits the message it is on', () => {
  it('opens the view in place: one edit, no new message', async () => {
    await tapAndSettle(tap(encodeMenuData({ view: 'portfolio' })));
    expect(calls('sendMessage')).toHaveLength(0);
    expect(calls('editMessageText')).toHaveLength(1);
    expect(calls('editMessageText')[0]).toMatchObject({ chat_id: String(CHAT), message_id: MESSAGE_ID });
    expect(calls('answerCallbackQuery')).toHaveLength(1);
  });

  it('a quick mute mutes the tapper for that long and shows the status', async () => {
    const hours = QUICK_MUTE_HOURS[1];
    await tapAndSettle(tap(encodeMenuData({ view: 'mute', hours })));
    const [userId, until] = vi.mocked(queries.muteUntil).mock.calls[0]!;
    expect(userId).toBe(USER);
    expect((until!.getTime() - Date.now()) / 3_600_000).toBeCloseTo(hours, 1);
    expect(toast()).toBe(MESSAGES.en.menu.status.mutedToast(hours));
    expect(lastText()).toContain(MESSAGES.en.menu.status.title);
  });

  it('Unmute clears the mute', async () => {
    await tapAndSettle(tap(encodeMenuData({ view: 'mute', hours: 0 })));
    expect(queries.muteUntil).toHaveBeenCalledWith(USER, null);
    expect(toast()).toBe(MESSAGES.en.menu.status.unmutedToast);
  });

  it('an agent’s view: schedule in New York slots, next scan, money, and its buttons', async () => {
    vi.mocked(queries.getAgent).mockResolvedValueOnce(agentRow() as never);
    vi.mocked(queries.listHoldings).mockResolvedValueOnce([holding('AAPL', '3.000000000000000000')] as never);
    await tapAndSettle(tap(encodeMenuData({ view: 'agent', agentId: AGENT })));

    expect(queries.getAgent).toHaveBeenCalledWith(USER, AGENT);
    const { menu, scheduledScans } = MESSAGES.en;
    const text = lastText();
    expect(text).toContain(menu.agent.schedule(['pre_open', 'ny_1000', 'ny_1400'].map((s) => scheduledScans.slot(s as never))));
    expect(text).toContain('Next scan: ');
    // Cash $9,303.58 + AAPL $696.42 = $10,000.00 against $10,000.00 deposited.
    expect(text).toContain(menu.agent.cash('$9,303.58', '$10,000.00'));
    expect(text).toContain(menu.agent.netWorth('$10,000.00', '$0.00', '0.00%'));
    expect(text).toContain(menu.agent.spentToday('$0.07', '$0.50'));
    expect(tapsOf(lastButtons())).toEqual([
      { view: 'agentLog', agentId: AGENT },
      { view: 'agent', agentId: AGENT },
      { view: 'agents' },
    ]);
  });

  it('an agent waiting for instructions says so instead of a next scan', async () => {
    vi.mocked(queries.getAgent).mockResolvedValueOnce(agentRow({ persona: null }) as never);
    await tapAndSettle(tap(encodeMenuData({ view: 'agent', agentId: AGENT })));
    expect(lastText()).toContain(MESSAGES.en.menu.agent.waitingForBrief);
    expect(lastText()).not.toContain('Next scan');
  });

  it('a paused agent shows no next scan', async () => {
    vi.mocked(queries.getAgent).mockResolvedValueOnce(agentRow({ state: 'paused' }) as never);
    await tapAndSettle(tap(encodeMenuData({ view: 'agent', agentId: AGENT })));
    expect(lastText()).toContain(MESSAGES.en.menu.agent.states.paused);
    expect(lastText()).not.toContain('Next scan');
  });

  it('a calendar that cannot be read says the next scan is not known', async () => {
    vi.mocked(queries.getAgent).mockResolvedValueOnce(agentRow() as never);
    const d = deps();
    vi.mocked((d.ai as { marketSessions: () => unknown }).marketSessions).mockRejectedValueOnce(new Error('down'));
    await tapAndSettle(tap(encodeMenuData({ view: 'agent', agentId: AGENT })), d);
    expect(lastText()).toContain(MESSAGES.en.menu.agent.nextScanUnknown);
  });

  it('an installation that does not schedule says so', async () => {
    vi.mocked(queries.getAgent).mockResolvedValueOnce(agentRow() as never);
    const d = deps();
    const config = { ...d.config, ENABLE_SCHEDULED_SCANS: false };
    await tapAndSettle(tap(encodeMenuData({ view: 'agent', agentId: AGENT })), { ...d, config });
    expect(lastText()).toContain(MESSAGES.en.menu.agent.notScheduledHere);
  });

  it('an agent holding something unpriced has no net worth, and says why', async () => {
    vi.mocked(queries.getAgent).mockResolvedValueOnce(agentRow() as never);
    vi.mocked(queries.listHoldings).mockResolvedValueOnce([holding('ACME', '1.000000000000000000')] as never);
    await tapAndSettle(tap(encodeMenuData({ view: 'agent', agentId: AGENT })));
    expect(lastText()).toContain(MESSAGES.en.menu.agent.unpriced(['ACME']));
    expect(lastText()).not.toContain('Net worth');
  });

  it('the last run never copies the scan’s error text into the chat', async () => {
    vi.mocked(queries.getAgent).mockResolvedValueOnce(agentRow() as never);
    vi.mocked(queries.listAgentScans).mockResolvedValueOnce([
      scanRow({ outcome: 'failed', answer: null, proposals: [], error: 'OperationalError: connection to ai-db:5432 refused' }),
    ] as never);
    await tapAndSettle(tap(encodeMenuData({ view: 'agentLog', agentId: AGENT })));
    expect(lastText()).toContain(MESSAGES.en.menu.log.outcome(MESSAGES.en.menu.log.outcomes.failed));
    expect(lastText()).not.toContain('5432');
  });

  it('the last run: when, why, what it proposed and refused, and what it cost', async () => {
    vi.mocked(queries.getAgent).mockResolvedValueOnce(agentRow() as never);
    vi.mocked(queries.listAgentScans).mockResolvedValueOnce([scanRow()] as never);
    await tapAndSettle(tap(encodeMenuData({ view: 'agentLog', agentId: AGENT })));

    expect(queries.listAgentScans).toHaveBeenCalledWith(USER, AGENT, { limit: 1 });
    const { log, pending } = MESSAGES.en.menu;
    const text = lastText();
    expect(text).toContain(`, ${log.triggers.schedule}\n`);
    expect(text).toContain(log.outcome(log.outcomes.trade));
    expect(text).toContain(log.trade('buy', '3', 'AAPL') + log.proposalNow(pending.states.pending!));
    expect(text).toContain(log.trade('sell', '1', 'VOO') + log.refused('not held'));
    expect(text).toContain(log.cost('$0.04', 'google/gemini-2.5-flash'));
    expect(tapsOf(lastButtons())).toEqual([
      { view: 'agentLog', agentId: AGENT },
      { view: 'agent', agentId: AGENT },
    ]);
  });

  it('a scan still running says so', async () => {
    vi.mocked(queries.getAgent).mockResolvedValueOnce(agentRow() as never);
    vi.mocked(queries.listAgentScans).mockResolvedValueOnce([
      scanRow({ finished_at: null, outcome: null, answer: null, proposals: [] }),
    ] as never);
    await tapAndSettle(tap(encodeMenuData({ view: 'agentLog', agentId: AGENT })));
    expect(lastText()).toContain(MESSAGES.en.menu.log.running);
  });
});

describe('whose data a tap reads', () => {
  it('an agent that is not the tapper’s is gone: the list instead, and nothing of the other agent', async () => {
    // getAgent(user, id) is scoped by user: somebody else's id finds nothing.
    vi.mocked(queries.getAgent).mockResolvedValueOnce(null);
    await tapAndSettle(tap(encodeMenuData({ view: 'agent', agentId: AGENT })));
    expect(queries.getAgent).toHaveBeenCalledWith(USER, AGENT);
    expect(toast()).toBe(MESSAGES.en.menu.agents.gone);
    expect(lastText()).toContain(MESSAGES.en.menu.agents.title);
    expect(queries.listAgentScans).not.toHaveBeenCalled();
  });

  it.each([
    ['the real portfolio', { is_primary: true }],
    ['an archived agent', { state: 'archived' }],
  ])('%s has no agent view', async (_label, overrides) => {
    vi.mocked(queries.getAgent).mockResolvedValueOnce(agentRow(overrides) as never);
    await tapAndSettle(tap(encodeMenuData({ view: 'agentLog', agentId: AGENT })));
    expect(toast()).toBe(MESSAGES.en.menu.agents.gone);
    expect(queries.listAgentScans).not.toHaveBeenCalled();
  });

  it('a chat that is not connected reads nothing and changes nothing', async () => {
    vi.mocked(queries.findTelegramBindingByChat).mockResolvedValue(null);
    for (const data of [encodeMenuData({ view: 'portfolio' }), encodeMenuData({ view: 'mute', hours: 4 })]) {
      await tapAndSettle(tap(data, 111));
    }
    vi.mocked(queries.findTelegramBindingByChat).mockResolvedValue({ user_id: USER, chat_id: String(CHAT) } as never);
    expect(queries.listHoldings).not.toHaveBeenCalled();
    expect(queries.muteUntil).not.toHaveBeenCalled();
    expect(calls('editMessageText')).toHaveLength(0);
    expect(toast()).toBe(MESSAGES.en.buttonInvalid);
  });

  it('menu data nobody wrote is refused without a read', async () => {
    await tapAndSettle(tap(`${MENU_PREFIX}u24`));
    expect(queries.muteUntil).not.toHaveBeenCalled();
    expect(calls('editMessageText')).toHaveLength(0);
    expect(toast()).toBe(MESSAGES.en.buttonInvalid);
  });
});

describe('private chats only (D272)', () => {
  const GROUP = -100123456;
  const inChat = (type: string | undefined, text: string) => ({
    message: { chat: { id: GROUP, ...(type === undefined ? {} : { type }) }, text },
  });

  it.each(['group', 'supergroup', 'channel'])('/start with a link in a %s is not redeemed: it says to connect privately', async (type) => {
    await handleTelegramUpdate(deps(), inChat(type, '/start some-link-token'));
    expect(queries.redeemTelegramBindToken).not.toHaveBeenCalled();
    expect(calls('sendMessage').map((m) => m.text)).toEqual([MESSAGES.en.privateChatOnly]);
  });

  it.each(['/portfolio', '/stop', 'what is my biggest holding?'])(
    'a group the bot was somehow bound to gets nothing for %s',
    async (text) => {
      // Even a bound group: the binding is not consulted at all.
      await handleTelegramUpdate(deps(), inChat('group', text));
      expect(queries.findTelegramBindingByChat).not.toHaveBeenCalled();
      expect(queries.deleteTelegramBinding).not.toHaveBeenCalled();
      expect(sent).toHaveLength(0);
    },
  );

  it('a chat Telegram did not call private is not treated as one', async () => {
    await handleTelegramUpdate(deps(), inChat(undefined, '/portfolio'));
    expect(queries.findTelegramBindingByChat).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it.each([
    ['a menu button', () => encodeMenuData({ view: 'mute', hours: QUICK_MUTE_HOURS[0] })],
    ['a signed proposal button', () => encodeCallbackData({ proposalId: AGENT, action: 'approve', nonce: mintNonce() }, SIGNING_SECRET)],
  ])('%s tapped in a group decides and reads nothing', async (_label, data) => {
    await handleTelegramUpdate(deps(), {
      callback_query: { id: 'cb-1', data: data(), message: { message_id: MESSAGE_ID, text: 'x', chat: { id: GROUP, type: 'group' } } },
    });
    expect(queries.findTelegramBindingByChat).not.toHaveBeenCalled();
    expect(queries.muteUntil).not.toHaveBeenCalled();
    expect(toast()).toBe(MESSAGES.en.buttonInvalid);
  });
});

describe('when a view cannot be shown', () => {
  it('a failed read is a toast, and the message is left as it was', async () => {
    vi.mocked(queries.listHoldings).mockRejectedValueOnce(new Error('connection refused'));
    await tapAndSettle(tap(encodeMenuData({ view: 'portfolio' })));
    expect(toast()).toBe(MESSAGES.en.menu.unavailable);
    expect(calls('editMessageText')).toHaveLength(0);
  });

  it('a Refresh that changed nothing is not an error the user sees', async () => {
    editRefusal = 'Bad Request: message is not modified';
    await tapAndSettle(tap(encodeMenuData({ view: 'status' })));
    expect(calls('editMessageText')).toHaveLength(1);
    expect(toast()).toBe('');
  });

  it('an edit Telegram refused for another reason is said, not a blank toast', async () => {
    editRefusal = 'Bad Request: message to edit not found';
    await tapAndSettle(tap(encodeMenuData({ view: 'status' })));
    expect(toast()).toBe(MESSAGES.en.menu.unavailable);
  });

  it('a quick mute that was applied is said even when the view after it fails', async () => {
    vi.mocked(queries.getOrCreateUserSettings)
      .mockResolvedValueOnce(settings as never) // the tap's language
      .mockRejectedValueOnce(new Error('connection refused')); // the view
    await tapAndSettle(tap(encodeMenuData({ view: 'mute', hours: QUICK_MUTE_HOURS[0] })));
    expect(queries.muteUntil).toHaveBeenCalled();
    expect(toast()).toBe(MESSAGES.en.menu.status.mutedToast(QUICK_MUTE_HOURS[0]));
  });

  it('a tap whose first read fails is still answered', async () => {
    vi.mocked(queries.findTelegramBindingByChat).mockRejectedValueOnce(new Error('connection refused'));
    await tapAndSettle(tap(encodeMenuData({ view: 'portfolio' })));
    expect(toast()).toBe(MESSAGES.en.menu.unavailable);
  });

  it('a command whose view fails is answered, not met with silence', async () => {
    vi.mocked(queries.listHoldings).mockRejectedValueOnce(new Error('connection refused'));
    await handleTelegramUpdate(deps(), command('/portfolio'));
    expect(calls('sendMessage').map((m) => m.text)).toEqual([MESSAGES.en.menu.unavailable]);
  });
});

describe('model spend', () => {
  it('a scan that cost under half a cent did not run for free', () => {
    expect(microUsd(1_200, MESSAGES.en)).toBe('<$0.01');
    expect(microUsd(0, MESSAGES.en)).toBe('$0.00');
    expect(microUsd(36_000, MESSAGES.en)).toBe('$0.04');
  });
});

describe('in Hebrew', () => {
  beforeEach(() => {
    settings = { ...settings, language: 'he' };
  });

  it('the help and its buttons are the Hebrew catalogue’s', async () => {
    await handleTelegramUpdate(deps(), command('/help'));
    expect(lastText()).toBe(MESSAGES.he.menu.help);
    expect(lastButtons()[0]?.text).toBe(MESSAGES.he.menu.buttons.portfolio);
  });

  it('a mute that ends on another day reads right to left: the date is isolated by its own direction', async () => {
    await handleTelegramUpdate(deps(), command('/mute 30h'));
    const text = lastText();
    // A Hebrew weekday inside a left-to-right isolate would be reordered for the reader.
    expect(text).not.toMatch(/\u2066[^\u2069]*[\u0590-\u05FF]/);
    expect(text).toMatch(/\u2068[^\u2069]*[\u0590-\u05FF][^\u2069]*\u2069/);
  });

  it('a toast after a quick mute is in Hebrew', async () => {
    await tapAndSettle(tap(encodeMenuData({ view: 'mute', hours: 1 })));
    expect(toast()).toBe(MESSAGES.he.menu.status.mutedToast(1));
  });
});

describe('the / command list', () => {
  it('is registered as the default list and for Hebrew phones, every command with a description', async () => {
    const { notifier } = deps();
    await registerBotCommands(notifier);
    const lists = calls('setMyCommands');
    expect(lists.map((list) => list.language_code)).toEqual([undefined, 'he']);
    for (const list of lists) {
      const commands = list.commands as { command: string; description: string }[];
      expect(commands.map((c) => c.command)).toEqual([...BOT_COMMANDS]);
      for (const { command: name, description } of commands) {
        // Telegram's own rules for a command and its description.
        expect(name).toMatch(/^[a-z0-9_]{1,32}$/);
        expect(description.trim().length).toBeGreaterThan(0);
        expect(description.length).toBeLessThanOrEqual(MAX_COMMAND_DESCRIPTION_CHARS);
      }
    }
  });

  it('a list Telegram refuses is logged, and nothing throws', async () => {
    commandsStatus = 400;
    const { notifier } = deps();
    await expect(registerBotCommands(notifier)).resolves.toBeUndefined();
    expect(calls('setMyCommands')).toHaveLength(2);
  });

  it.each(['en', 'he'] as const)('the %s help names every other command the list offers', (language) => {
    // A command added to the list without a line in the help shows up here.
    for (const name of BOT_COMMANDS.filter((c) => c !== 'help')) {
      expect(MESSAGES[language].menu.help).toContain(`/${name}`);
    }
  });
});
