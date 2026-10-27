/**
 * The Telegram agent controls (M11 A2): Run a scan now behind a confirm that
 * names its cost, Pause and Resume, and a new schedule - signed buttons that
 * expire, through the services the agent page uses.
 *
 * No network: the Telegram client records what it would send; the AI client
 * is the fixture fake with a scripted `scanAgent`.
 */

import { PAYER_REFUSALS } from '@traders/shared';
import { AiServiceError } from '@traders/shared/ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER = '00000000-0000-0000-0000-000000000001';
const AGENT = '90000000-0000-0000-0000-0000000000a1';
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
    holdings_count: 0,
    cash_minor: '1000000',
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

let agent: Record<string, unknown> | null = agentRow();
let role = 'user';

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
  getOrCreateUserSettings: vi.fn(async () => ({ language: 'en', notify_severity: 'high', muted_until: null })),
  getUser: vi.fn(async () => ({ id: USER, role, base_currency: 'USD', timezone: 'Asia/Jerusalem' })),
  // Scoped by user, as the SQL is: another user's agent is not found.
  getAgent: vi.fn(async (userId: string, agentId: string) => (userId === USER && agentId === AGENT ? agent : null)),
  updateAgent: vi.fn(async (_userId: string, _agentId: string, patch: Record<string, unknown>) => ({
    ...agent,
    ...(patch.state === undefined ? {} : { state: patch.state }),
  })),
  countActiveAgents: vi.fn(async () => 1),
  countLiveAgents: vi.fn(async () => 1),
  getInstallationSettings: vi.fn(async () => ({ max_agents_per_user: 3 })),
  sumFeesPaid: vi.fn(async () => 0),
  listHoldings: vi.fn(async () => []),
  listAgentScans: vi.fn(async () => []),
  listAgents: vi.fn(async () => []),
  findProposal: vi.fn(async () => null),
}));

const queries = await import('../src/db/queries.js');
const { handleTelegramUpdate } = await import('../src/telegram/updates.js');
const { TelegramNotifier } = await import('../src/telegram/client.js');
const { MESSAGES } = await import('../src/notify/messages.js');
const { loadConfig, resetConfigForTests } = await import('../src/config.js');
const { createFakeAi } = await import('./fakeAi.js');
const { memoryRateLimits, RATE_LIMITS, userKey } = await import('../src/http/rateLimits.js');
const { decodeMenuData, encodeMenuData } = await import('../src/telegram/menuData.js');
const { MAX_CALLBACK_DATA_BYTES, decodeCallbackData, encodeCallbackData, mintNonce } = await import(
  '../src/telegram/callbackToken.js'
);
const { decodeSignupData } = await import('../src/telegram/signupToken.js');
const { AGENT_ACTION_TTL_MINUTES, charToSchedule, decodeAgentActionData, encodeAgentActionData, scheduleToChar } =
  await import('../src/telegram/agentActionToken.js');
const { MEASURED_SCAN_COST_MICRO_USD } = await import('../src/http/routes/agents.js');
const { microUsd } = await import('../src/telegram/menu.js');
const { MAX_SCAN_EVERY_HOURS, MIN_SCAN_EVERY_HOURS } = await import('@traders/shared');

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

const SCAN = {
  scan_id: 's-1',
  outcome: 'no_trade',
  steps: 4,
  cost_micro_usd: 30_000,
  model: 'm',
  answer: null,
  error: null,
};

let sent: { method: string; body: Record<string, unknown> }[] = [];
const scanAgent = vi.fn();

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
  const ai = { ...createFakeAi(), scanAgent, marketSessions: vi.fn(async () => ({ sessions: [] })) };
  return { config: loadConfig(ENV), notifier, ai: ai as never, rateLimits: memoryRateLimits() };
}

const calls = (method: string) => sent.filter((call) => call.method === method).map((call) => call.body);
const toast = () => calls('answerCallbackQuery').at(-1)?.text;
const lastEdit = () => calls('editMessageText').at(-1);
type Button = { text: string; callback_data?: string };
const buttonsOf = (body: Record<string, unknown> | undefined): Button[] =>
  ((body?.reply_markup as { inline_keyboard?: Button[][] } | undefined)?.inline_keyboard ?? []).flat();
const signed = (buttons: Button[]) =>
  buttons
    .map((b) => (b.callback_data === undefined ? null : decodeAgentActionData(b.callback_data, SIGNING_SECRET)))
    .filter((d) => d !== null)
    .map((d) => d!.payload);

const tapUpdate = (data: string) => ({
  callback_query: {
    id: 'cb-1',
    data,
    message: { message_id: MESSAGE_ID, text: 'old view', chat: { id: CHAT, type: 'private' } },
  },
});

/** A tap is handled off the poller; its answer is sent once the redraw is done. */
async function tap(data: string, d = deps()) {
  await handleTelegramUpdate(d, tapUpdate(data));
  await vi.waitFor(() => expect(calls('answerCallbackQuery')).not.toHaveLength(0));
  return d;
}

const action = (payload: Parameters<typeof encodeAgentActionData>[0], at?: Date) =>
  encodeAgentActionData(payload, SIGNING_SECRET, at);

beforeEach(() => {
  sent = [];
  agent = agentRow();
  role = 'user';
  scanAgent.mockReset();
  scanAgent.mockResolvedValue(SCAN);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('the signed agent button', () => {
  const schedules = [null, ...Array.from({ length: MAX_SCAN_EVERY_HOURS - MIN_SCAN_EVERY_HOURS + 1 }, (_, i) => MIN_SCAN_EVERY_HOURS + i)].flatMap(
    (everyHours) =>
      [false, true].flatMap((preOpen) => [false, true].map((postClose) => ({ everyHours, preOpen, postClose }))),
  );

  it.each(['run', 'pause', 'resume'] as const)('round-trips %s inside Telegram’s limit', (name) => {
    const data = action({ agentId: AGENT, action: name });
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(MAX_CALLBACK_DATA_BYTES);
    expect(decodeAgentActionData(data, SIGNING_SECRET)).toEqual({ payload: { agentId: AGENT, action: name }, expired: false });
  });

  it('carries every schedule the web offers, each in one character', () => {
    for (const schedule of schedules) {
      expect(charToSchedule(scheduleToChar(schedule))).toEqual(schedule);
      const data = action({ agentId: AGENT, action: 'schedule', schedule });
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(MAX_CALLBACK_DATA_BYTES);
      expect(decodeAgentActionData(data, SIGNING_SECRET)?.payload).toEqual({ agentId: AGENT, action: 'schedule', schedule });
    }
    expect(() => scheduleToChar({ everyHours: MAX_SCAN_EVERY_HOURS + 1, preOpen: false, postClose: false })).toThrow();
  });

  it('expires: still itself, but marked, once its time has passed', () => {
    const drawn = new Date('2026-10-22T10:00:00Z');
    const data = action({ agentId: AGENT, action: 'pause' }, drawn);
    const at = (minutes: number) => new Date(drawn.getTime() + minutes * 60_000);
    expect(decodeAgentActionData(data, SIGNING_SECRET, at(AGENT_ACTION_TTL_MINUTES))?.expired).toBe(false);
    expect(decodeAgentActionData(data, SIGNING_SECRET, at(AGENT_ACTION_TTL_MINUTES + 1))?.expired).toBe(true);
    // A button "from the future" beyond any clock skew is not believed either.
    expect(decodeAgentActionData(data, SIGNING_SECRET, at(-5))?.expired).toBe(true);
  });

  it('refuses an edited button and another secret', () => {
    const data = action({ agentId: AGENT, action: 'pause' });
    const edited = data.replace(/^(.{22})p/, '$1a');
    expect(decodeAgentActionData(edited, SIGNING_SECRET)).toBeNull();
    expect(decodeAgentActionData(data, 'another-secret-long-enough')).toBeNull();
  });

  it('is never read as a proposal, sign-up or menu button, nor they as it', () => {
    const data = action({ agentId: AGENT, action: 'run' });
    expect(decodeCallbackData(data, SIGNING_SECRET)).toBeNull();
    expect(decodeSignupData(data, SIGNING_SECRET)).toBeNull();
    expect(decodeMenuData(data)).toBeNull();
    const proposal = encodeCallbackData({ proposalId: AGENT, action: 'reject', nonce: mintNonce() }, SIGNING_SECRET);
    expect(decodeAgentActionData(proposal, SIGNING_SECRET)).toBeNull();
  });
});

describe('the agent’s view offers the controls its state allows', () => {
  it('an active agent: Run now and Pause', async () => {
    await tap(encodeMenuData({ view: 'agent', agentId: AGENT }));
    const buttons = buttonsOf(lastEdit());
    expect(buttons.map((b) => b.text)).toContain(MESSAGES.en.menu.buttons.runScan);
    expect(signed(buttons)).toEqual([{ agentId: AGENT, action: 'pause' }]);
  });

  it('a paused agent: Resume, and no Run', async () => {
    agent = agentRow({ state: 'paused' });
    await tap(encodeMenuData({ view: 'agent', agentId: AGENT }));
    const buttons = buttonsOf(lastEdit());
    expect(buttons.map((b) => b.text)).not.toContain(MESSAGES.en.menu.buttons.runScan);
    expect(signed(buttons)).toEqual([{ agentId: AGENT, action: 'resume' }]);
  });

  it('an agent with nothing to decide by: no Run', async () => {
    agent = agentRow({ persona: null });
    await tap(encodeMenuData({ view: 'agent', agentId: AGENT }));
    expect(buttonsOf(lastEdit()).map((b) => b.text)).not.toContain(MESSAGES.en.menu.buttons.runScan);
  });

  it('an installation that signs nothing offers no Run or schedule: their screens would be dead ends', async () => {
    const d = deps();
    await tap(encodeMenuData({ view: 'agent', agentId: AGENT }), { ...d, config: { ...d.config, TELEGRAM_SIGNING_SECRET: undefined } });
    const labels = buttonsOf(lastEdit()).map((b) => b.text);
    expect(labels).not.toContain(MESSAGES.en.menu.buttons.runScan);
    expect(labels).not.toContain(MESSAGES.en.menu.buttons.schedule);
  });

  it('an agent already scanning: no Run', async () => {
    agent = agentRow({ running_scan: { trigger: 'schedule', started_at: new Date().toISOString() } });
    await tap(encodeMenuData({ view: 'agent', agentId: AGENT }));
    expect(buttonsOf(lastEdit()).map((b) => b.text)).not.toContain(MESSAGES.en.menu.buttons.runScan);
  });
});

describe('an account that has not accepted the current terms (D320)', () => {
  it('runs nothing from a signed agent button', async () => {
    vi.mocked(queries.findTelegramBindingByChat).mockResolvedValueOnce({ user_id: USER, chat_id: String(CHAT), legal_accepted: false } as never);
    await tap(action({ agentId: AGENT, action: 'run' }));
    expect(toast()).toBe(MESSAGES.en.legalAcceptanceRequiredShort);
    expect(scanAgent).not.toHaveBeenCalled();
    expect(calls('editMessageText')).toHaveLength(0);
  });
});

describe('Run a scan now', () => {
  it('first asks, naming the cost and the budget it comes from', async () => {
    await tap(encodeMenuData({ view: 'runConfirm', agentId: AGENT }));
    const cost = microUsd(MEASURED_SCAN_COST_MICRO_USD, MESSAGES.en);
    expect(lastEdit()?.text).toContain(MESSAGES.en.menu.run.confirm('Tech Stocks', cost, '$0.07', '$0.50'));
    const buttons = buttonsOf(lastEdit());
    expect(signed(buttons)).toEqual([{ agentId: AGENT, action: 'run' }]);
    expect(buttons.map((b) => b.text)).toEqual([MESSAGES.en.menu.buttons.confirmRun(cost), MESSAGES.en.menu.buttons.cancel]);
    expect(scanAgent).not.toHaveBeenCalled();
  });

  it('a confirm for an agent that cannot scan says why, on the agent’s view', async () => {
    agent = agentRow({ persona: null });
    await tap(encodeMenuData({ view: 'runConfirm', agentId: AGENT }));
    expect(toast()).toBe(MESSAGES.en.menu.run.refusals.no_persona);
    expect(lastEdit()?.text).toContain('🤖');
  });

  it('confirmed: the confirm goes at once, the scan runs, and its last run replaces the message', async () => {
    await tap(action({ agentId: AGENT, action: 'run' }));
    expect(toast()).toBe(MESSAGES.en.menu.run.startedToast);
    const first = calls('editMessageText')[0]!;
    expect(first.text).toBe(MESSAGES.en.menu.run.running('Tech Stocks'));
    expect(buttonsOf(first)).toEqual([]);
    expect(scanAgent).toHaveBeenCalledWith(AGENT, { user_id: USER, trigger: 'manual' }, undefined);
    await vi.waitFor(() => expect(String(lastEdit()?.text)).toContain(MESSAGES.en.menu.log.title('Tech Stocks')));
  });

  it('counts against the page’s own limit, and a spent limit starts nothing', async () => {
    const d = deps();
    for (let i = 0; i < RATE_LIMITS.agentScan.points; i += 1) await d.rateLimits.take('agentScan', userKey(USER));
    await tap(action({ agentId: AGENT, action: 'run' }), d);
    expect(scanAgent).not.toHaveBeenCalled();
    expect(queries.getAgent).not.toHaveBeenCalled();
    const said = Array.from({ length: RATE_LIMITS.agentScan.durationSeconds / 60 + 1 }, (_, m) => MESSAGES.en.rateLimited(m));
    expect(said).toContain(toast());
    expect(calls('editMessageText')).toHaveLength(0);
  });

  it('the AI service’s refusal is said above the agent’s view', async () => {
    scanAgent.mockRejectedValue(
      new AiServiceError('AI service 409', 409, { detail: { code: 'scan_running', message: 'x' } }),
    );
    await tap(action({ agentId: AGENT, action: 'run' }));
    await vi.waitFor(() =>
      expect(String(lastEdit()?.text)).toContain(MESSAGES.en.menu.run.failed(MESSAGES.en.menu.run.refusals.scan_running)),
    );
  });

  it.each(PAYER_REFUSALS)('a user nobody may pay for is told why in their words (%s, D245)', async (code) => {
    scanAgent.mockRejectedValue(new AiServiceError('AI service 409', 409, { detail: { code, message: 'x' } }));
    await tap(action({ agentId: AGENT, action: 'run' }));
    await vi.waitFor(() =>
      expect(String(lastEdit()?.text)).toContain(MESSAGES.en.menu.run.failed(MESSAGES.en.menu.run.refusals[code])),
    );
  });

  it('the tap is answered while the scan is still running: the poller is not held', async () => {
    let finish: (value: unknown) => void = () => undefined;
    scanAgent.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await tap(action({ agentId: AGENT, action: 'run' }));
    expect(scanAgent).toHaveBeenCalled();
    expect(lastEdit()?.text).toBe(MESSAGES.en.menu.run.running('Tech Stocks'));
    finish(SCAN);
    await vi.waitFor(() => expect(String(lastEdit()?.text)).toContain(MESSAGES.en.menu.log.title('Tech Stocks')));
  });

  it('an agent with nothing to decide by is not scanned, whatever the button says', async () => {
    agent = agentRow({ persona: null });
    await tap(action({ agentId: AGENT, action: 'run' }));
    expect(scanAgent).not.toHaveBeenCalled();
    expect(toast()).toBe(MESSAGES.en.menu.run.refusals.no_persona);
  });

  it('a paused agent is not scanned, whatever the button says', async () => {
    agent = agentRow({ state: 'paused' });
    await tap(action({ agentId: AGENT, action: 'run' }));
    expect(scanAgent).not.toHaveBeenCalled();
    expect(toast()).toBe(MESSAGES.en.menu.run.refusals.agent_not_active);
  });

  it('an expired Run is redrawn, not run', async () => {
    await tap(action({ agentId: AGENT, action: 'run' }, new Date(Date.now() - (AGENT_ACTION_TTL_MINUTES + 2) * 60_000)));
    expect(scanAgent).not.toHaveBeenCalled();
    expect(toast()).toBe(MESSAGES.en.menu.control.expired);
    expect(lastEdit()?.text).toContain('🤖');
  });
});

describe('expired and edited buttons', () => {
  const stale = () => new Date(Date.now() - (AGENT_ACTION_TTL_MINUTES + 2) * 60_000);

  it.each([
    ['Pause', { agentId: AGENT, action: 'pause' } as const],
    ['a schedule', { agentId: AGENT, action: 'schedule', schedule: { everyHours: 1, preOpen: false, postClose: false } } as const],
  ])('an expired %s writes nothing, and the redrawn buttons are fresh', async (_label, payload) => {
    await tap(action(payload, stale()));
    expect(queries.updateAgent).not.toHaveBeenCalled();
    expect(toast()).toBe(MESSAGES.en.menu.control.expired);
    const redrawn = buttonsOf(lastEdit())
      .map((b) => (b.callback_data === undefined ? null : decodeAgentActionData(b.callback_data, SIGNING_SECRET)))
      .filter((d) => d !== null);
    expect(redrawn.length).toBeGreaterThan(0);
    expect(redrawn.every((d) => !d!.expired)).toBe(true);
  });

  it('an edited agent button is refused as invalid, and writes nothing', async () => {
    const edited = action({ agentId: AGENT, action: 'pause' }).replace(/^(.{22})p/, '$1a');
    await tap(edited);
    expect(queries.updateAgent).not.toHaveBeenCalled();
    expect(toast()).toBe(MESSAGES.en.buttonInvalid);
  });
});

describe('Pause and Resume', () => {
  it('Pause pauses the tapper’s agent and redraws it', async () => {
    await tap(action({ agentId: AGENT, action: 'pause' }));
    expect(queries.updateAgent).toHaveBeenCalledWith(USER, AGENT, { state: 'paused' }, { unlessArchived: true });
    expect(toast()).toBe(MESSAGES.en.menu.control.pausedToast);
    expect(lastEdit()).toMatchObject({ message_id: MESSAGE_ID });
  });

  it('Resume at the active-agent limit is refused with the limit, and nothing is written', async () => {
    agent = agentRow({ state: 'paused' });
    vi.mocked(queries.countActiveAgents).mockResolvedValueOnce(3);
    await tap(action({ agentId: AGENT, action: 'resume' }));
    expect(queries.updateAgent).not.toHaveBeenCalled();
    expect(toast()).toBe(MESSAGES.en.menu.control.limitReached(3));
  });

  it('the admin has no active-agent limit (D201)', async () => {
    agent = agentRow({ state: 'paused' });
    role = 'admin';
    vi.mocked(queries.countActiveAgents).mockResolvedValueOnce(3);
    await tap(action({ agentId: AGENT, action: 'resume' }));
    expect(queries.updateAgent).toHaveBeenCalledWith(USER, AGENT, { state: 'active' }, { unlessArchived: true });
  });

  it('a button naming an agent that is not the tapper’s changes nothing', async () => {
    const other = '90000000-0000-0000-0000-0000000000ff';
    await tap(action({ agentId: other, action: 'pause' }));
    expect(queries.getAgent).toHaveBeenCalledWith(USER, other);
    expect(queries.updateAgent).not.toHaveBeenCalled();
    expect(toast()).toBe(MESSAGES.en.menu.agents.gone);
  });

  it('a chat that is not connected changes nothing', async () => {
    vi.mocked(queries.findTelegramBindingByChat).mockResolvedValueOnce(null);
    await tap(action({ agentId: AGENT, action: 'pause' }));
    expect(queries.updateAgent).not.toHaveBeenCalled();
    expect(toast()).toBe(MESSAGES.en.buttonInvalid);
  });
});

describe('the schedule', () => {
  it('offers every interval and both edges, each setting the whole schedule with one thing changed', async () => {
    await tap(encodeMenuData({ view: 'schedule', agentId: AGENT }));
    const payloads = signed(buttonsOf(lastEdit()));
    const current = { everyHours: 4, preOpen: true, postClose: false };
    const intervals = MAX_SCAN_EVERY_HOURS - MIN_SCAN_EVERY_HOURS + 2; // and "none"
    expect(payloads).toHaveLength(intervals + 2);
    const everyHours = [null, ...Array.from({ length: intervals - 1 }, (_, i) => MIN_SCAN_EVERY_HOURS + i)];
    expect(payloads).toEqual([
      ...everyHours.map((hours) => ({ agentId: AGENT, action: 'schedule', schedule: { ...current, everyHours: hours } })),
      { agentId: AGENT, action: 'schedule', schedule: { ...current, preOpen: false } },
      { agentId: AGENT, action: 'schedule', schedule: { ...current, postClose: true } },
    ]);
    // The current interval is marked.
    expect(buttonsOf(lastEdit()).map((b) => b.text)).toContain(`• ${MESSAGES.en.menu.buttons.everyHours(4)}`);
  });

  it('a tap saves it and redraws the picker', async () => {
    const schedule = { everyHours: 2, preOpen: false, postClose: true };
    await tap(action({ agentId: AGENT, action: 'schedule', schedule }));
    expect(queries.updateAgent).toHaveBeenCalledWith(USER, AGENT, { scanSchedule: schedule }, { unlessArchived: true });
    expect(toast()).toBe(MESSAGES.en.menu.control.scheduleSavedToast);
    expect(lastEdit()?.text).toContain(MESSAGES.en.menu.schedule.title('Tech Stocks'));
  });

  it('the real portfolio has no schedule to set', async () => {
    agent = agentRow({ is_primary: true });
    await tap(action({ agentId: AGENT, action: 'schedule', schedule: { everyHours: 2, preOpen: false, postClose: false } }));
    expect(queries.updateAgent).not.toHaveBeenCalled();
  });
});

describe('D276: the bot and the services never import a route', () => {
  it('no module under src/telegram or src/services names src/http/routes', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = new URL('../src/', import.meta.url).pathname;
    for (const dir of ['telegram', 'services']) {
      for (const file of readdirSync(join(root, dir)).filter((f) => f.endsWith('.ts'))) {
        expect(readFileSync(join(root, dir, file), 'utf8'), `${dir}/${file}`).not.toMatch(/from '[^']*http\/routes\//);
      }
    }
  });
});
