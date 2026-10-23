/**
 * Re-checking an expired trade proposal (D212-D217): what a re-check came to,
 * when *Re-check* is offered, the web route, and the Telegram tap.
 *
 * The database is mocked and the AI service faked: the re-check itself - the
 * focused scan, "once", the old thesis kept out of the evidence - is tested in
 * the AI service over real SQL. Writing the new proposal is `proposeFromScan`'s,
 * tested in `tradeProposals.test.ts`; here it is mocked, and what is pinned is
 * that a kept trade reaches it and its id comes back.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RECHECK_WINDOW_DAYS, type RecheckResult } from '@traders/shared';
import { AiServiceError } from '@traders/shared/ai';

import { createFakeAi } from './fakeAi.js';
import { ACTIVE_SESSION, sessionCookie } from './session.js';
import { RATE_LIMITS, memoryRateLimits, userKey } from '../src/http/rateLimits.js';
import { minutesOf } from '../src/telegram/assistantQuestion.js';

const USER = { ...ACTIVE_SESSION, id: '00000000-0000-0000-0000-000000000001', email: null, base_currency: 'USD', timezone: 'UTC' };
const AGENT = '90000000-0000-0000-0000-0000000000a1';
const PROPOSAL = '50000000-0000-0000-0000-000000000022';
const NOW = new Date('2026-10-20T15:00:00Z');
const HOUR = 3_600_000;

function proposalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PROPOSAL,
    user_id: USER.id,
    observation_id: 'o-1',
    kind: 'buy',
    payload: { symbol: 'CCJ', quantity: '2', priceMinor: 5100, currency: 'USD' },
    state: 'expired',
    expires_at: new Date(NOW.getTime() - HOUR),
    snoozed_until: null,
    decided_at: new Date(NOW.getTime() - HOUR),
    decided_via: 'system',
    created_at: new Date(NOW.getTime() - 2 * HOUR),
    severity: 'notable',
    subject_ref: 'instrument:CCJ',
    headline: 'Value proposes to buy 2 CCJ at 51.00',
    explanation: 'CCJ fell.',
    localized: {},
    evidence: {},
    agent_id: AGENT,
    agent_name: 'Value',
    agent_is_primary: false,
    scan_id: 's-0',
    scan_tool_calls: null,
    ...overrides,
  };
}

let proposal: Record<string, unknown> | null = proposalRow();
let agent: Record<string, unknown> | null = { id: AGENT, state: 'active', is_primary: false, name: 'Value' };
let latest: Record<string, unknown> | null = null;
let later: string | null = null;

vi.mock('../src/db/pool.js', () => ({
  queryOne: vi.fn(async () => ({ ok: 1 })),
  query: vi.fn(async () => []),
  transaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({})),
  initPool: vi.fn(),
  getPool: vi.fn(),
  closePool: vi.fn(),
}));

vi.mock('../src/db/queries.js', () => ({
  findProposal: vi.fn(async () => proposal),
  getAgent: vi.fn(async () => agent),
  latestRecheck: vi.fn(async () => latest),
  laterApprovedProposal: vi.fn(async () => later),
  getUser: vi.fn(async () => USER),
  listProposalTransitions: vi.fn(async () => []),
  listProposalAttempts: vi.fn(async () => []),
}));

vi.mock('../src/services/tradeProposals.js', () => ({ proposeFromScan: vi.fn(async () => []) }));

const { recheckResultOf, recheckStatus, recheckProposal } = await import('../src/services/proposalRecheck.js');
const { recheckLine, startRecheckCallback } = await import('../src/telegram/proposalRecheck.js');
const { messagesFor } = await import('../src/notify/messages.js');
const { proposeFromScan } = await import('../src/services/tradeProposals.js');
const { loadConfig, resetConfigForTests } = await import('../src/config.js');
const { createApp } = await import('../src/http/app.js');

const SCAN = {
  scan_id: 'b0000000-0000-0000-0000-000000000002',
  outcome: 'no_trade' as const,
  steps: 1,
  cost_micro_usd: 2000,
  model: 'm',
  answer: { trades: [], thesis: 'Above where it was worth buying.', problems: [] },
  error: null,
};

function scanRow(overrides: Record<string, unknown> = {}) {
  return {
    scan_id: SCAN.scan_id,
    started_at: new Date(NOW.getTime() - 60_000),
    finished_at: NOW,
    outcome: 'no_trade',
    answer: SCAN.answer,
    new_proposal_id: null,
    ...overrides,
  };
}

function fakeAi(recheck: (...args: unknown[]) => Promise<unknown>) {
  const ai = createFakeAi();
  Object.assign(ai, { recheckProposal: vi.fn(recheck) });
  return ai as typeof ai & { recheckProposal: ReturnType<typeof vi.fn> };
}

const NOTIFIER = { send: vi.fn() } as never;

beforeEach(() => {
  vi.clearAllMocks();
  proposal = proposalRow();
  agent = { id: AGENT, state: 'active', is_primary: false, name: 'Value' };
  latest = null;
  later = null;
});

describe('what a re-check came to', () => {
  it('is the new proposal when one was raised', () => {
    expect(recheckResultOf(scanRow({ outcome: 'trade', new_proposal_id: 'p-2' }), NOW)).toMatchObject({
      outcome: 'proposed',
      proposalId: 'p-2',
    });
  });

  it("is the agent's own reason for a pass (D214)", () => {
    expect(recheckResultOf(scanRow(), NOW)).toMatchObject({
      outcome: 'declined',
      reason: { kind: 'agent', thesis: 'Above where it was worth buying.' },
    });
  });

  it('is the check that refused the trade, by code', () => {
    const answer = { trades: [{ symbol: 'CCJ', refused: true, code: 'mandate', problems: ['p'] }], problems: ['p'] };
    expect(recheckResultOf(scanRow({ outcome: 'rule_rejected', answer }), NOW)).toMatchObject({
      outcome: 'declined',
      reason: { kind: 'check', check: 'mandate' },
    });
  });

  it('is no_answer when the model gave nothing the server could read', () => {
    expect(recheckResultOf(scanRow({ outcome: 'step_limit', answer: null }), NOW)).toMatchObject({
      reason: { kind: 'check', check: 'no_answer' },
    });
  });

  it('is unanswered - and not used up - for a failure, a budget, the cap or an own key (D213)', () => {
    for (const cause of ['failed', 'budget_reached', 'cap_reached', 'own_key_failed']) {
      expect(recheckResultOf(scanRow({ outcome: cause }), NOW)).toMatchObject({ outcome: 'unanswered', cause });
    }
  });

  it('is running while unfinished, and a failure once it was abandoned', () => {
    expect(recheckResultOf(scanRow({ outcome: null, finished_at: null }), NOW).outcome).toBe('running');
    const old = scanRow({ outcome: null, finished_at: null, started_at: new Date(NOW.getTime() - HOUR) });
    expect(recheckResultOf(old, NOW)).toMatchObject({ outcome: 'unanswered', cause: 'failed' });
  });
});

describe('when Re-check is offered (D215)', () => {
  const blocked = async () => (await recheckStatus(USER.id, proposal as never, NOW))?.blocked;

  it('is offered for a trade that expired unanswered within the window', async () => {
    expect(await blocked()).toBeNull();
    proposal = proposalRow({ state: 'pending', decided_at: null, decided_via: null });
    expect(await blocked()).toBeNull();
  });

  it('is not before the deadline, nor for a rejection or an approval', async () => {
    proposal = proposalRow({ state: 'pending', expires_at: new Date(NOW.getTime() + HOUR) });
    expect(await blocked()).toBe('not_expired');
    proposal = proposalRow({ state: 'rejected', decided_via: 'web' });
    expect(await blocked()).toBe('not_expired');
  });

  it(`is not past ${RECHECK_WINDOW_DAYS} days`, async () => {
    const window = RECHECK_WINDOW_DAYS * 24 * HOUR;
    proposal = proposalRow({ expires_at: new Date(NOW.getTime() - window) });
    expect(await blocked()).toBeNull();
    proposal = proposalRow({ expires_at: new Date(NOW.getTime() - window - 1) });
    expect(await blocked()).toBe('recheck_window_passed');
  });

  it('is not once a re-check counted, and is again after one that reached no answer', async () => {
    latest = scanRow();
    expect(await blocked()).toBe('already_rechecked');
    latest = scanRow({ outcome: 'budget_reached', answer: null });
    expect(await blocked()).toBeNull();
    latest = scanRow({ outcome: null, finished_at: null });
    expect(await blocked()).toBe('scan_running');
  });

  it('is not when a later approved proposal already made the trade (D218)', async () => {
    later = 'p-later';
    expect(await blocked()).toBe('superseded');
    expect((await recheckStatus(USER.id, proposal as never, NOW))?.recheck.supersededBy).toBe('p-later');
  });

  it('is not for a paused agent', async () => {
    agent = { id: AGENT, state: 'paused', is_primary: false };
    expect(await blocked()).toBe('agent_not_active');
  });

  it('is not asked of any other kind', async () => {
    proposal = proposalRow({ kind: 'rebalance' });
    expect(await recheckStatus(USER.id, proposal as never, NOW)).toBeNull();
  });
});

describe('running a re-check', () => {
  it('asks the AI service for the user, and returns the new proposal a kept trade became', async () => {
    const kept = { ...SCAN, outcome: 'trade' as const, answer: { trades: [{ decision: 'buy', symbol: 'CCJ', refused: false }] } };
    const ai = fakeAi(async () => kept);
    vi.mocked(proposeFromScan).mockResolvedValueOnce(['p-2']);
    const result = await recheckProposal(USER.id, PROPOSAL, { ai, notifier: NOTIFIER, now: () => NOW });
    expect(ai.recheckProposal).toHaveBeenCalledWith(AGENT, PROPOSAL, { user_id: USER.id }, undefined);
    expect(vi.mocked(proposeFromScan).mock.calls[0]![2]).toBe(kept);
    expect(result).toMatchObject({ outcome: 'proposed', proposalId: 'p-2', scanId: SCAN.scan_id });
  });

  it("passes the AI service's refusal on with its code", async () => {
    const ai = fakeAi(async () => {
      throw new AiServiceError('refused', 409, { detail: { code: 'already_rechecked', message: 'once' } });
    });
    await expect(recheckProposal(USER.id, PROPOSAL, { ai, notifier: NOTIFIER })).rejects.toMatchObject({
      status: 409,
      code: 'already_rechecked',
    });
    expect(proposeFromScan).not.toHaveBeenCalled();
  });

  it('refuses a proposal that is not a trade without asking the AI service', async () => {
    proposal = proposalRow({ kind: 'rebalance' });
    const ai = fakeAi(async () => SCAN);
    await expect(recheckProposal(USER.id, PROPOSAL, { ai, notifier: NOTIFIER })).rejects.toMatchObject({
      code: 'not_a_trade',
    });
    expect(ai.recheckProposal).not.toHaveBeenCalled();
  });
});

describe('the web route', () => {
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

  function app(ai = fakeAi(async () => SCAN)) {
    resetConfigForTests();
    const created = createApp(loadConfig(ENV), ai);
    const cookie = sessionCookie();
    return {
      post: (path: string) => created.request(path, { method: 'POST', headers: { ...HEADERS, cookie } }),
      get: (path: string) => created.request(path, { headers: { ...HEADERS, cookie } }),
    };
  }

  it('re-checks and answers what it came to', async () => {
    const response = await app().post(`/proposals/${PROPOSAL}/recheck`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      outcome: 'declined',
      reason: { kind: 'agent', thesis: 'Above where it was worth buying.' },
    });
  });

  it("is a 409 with the AI service's code when it refuses", async () => {
    const ai = fakeAi(async () => {
      throw new AiServiceError('refused', 409, { detail: { code: 'budget_spent', message: 'spent' } });
    });
    const response = await app(ai).post(`/proposals/${PROPOSAL}/recheck`);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe('budget_spent');
  });

  it("puts the re-check on a trade proposal's page, and none on any other", async () => {
    latest = scanRow();
    const body = await (await app().get(`/proposals/${PROPOSAL}`)).json();
    expect(body.recheck).toMatchObject({ available: false, last: { outcome: 'declined' } });
    proposal = proposalRow({ kind: 'rebalance', scan_id: null });
    expect((await (await app().get(`/proposals/${PROPOSAL}`)).json()).recheck).toBeNull();
  });
});

describe('Re-check from Telegram (D217)', () => {
  function chat() {
    return {
      answerCallback: vi.fn(async () => ({ delivered: true })),
      showWorking: vi.fn(async () => ({ delivered: true })),
      setKeyboard: vi.fn(async () => ({ delivered: true })),
      editMessage: vi.fn(async () => ({ delivered: true })),
    };
  }

  async function tap(
    telegram: ReturnType<typeof chat>,
    ai = fakeAi(async () => SCAN),
    language = 'en',
    rateLimits = memoryRateLimits(),
    fromPending = false,
  ) {
    const started = await startRecheckCallback({
      telegram: telegram as never,
      ai,
      notifier: NOTIFIER,
      rateLimits,
      userId: USER.id,
      language,
      callbackId: 'cb-1',
      chatId: '42',
      message: { message_id: 7, text: 'Value proposes to buy 2 CCJ at 51.00', fromPending },
      payload: { proposalId: PROPOSAL, action: 'recheck', nonce: 'n' },
      now: () => NOW,
    });
    await started.done;
  }

  it('answers at once, then adds what the re-check came to under the message', async () => {
    const telegram = chat();
    await tap(telegram);
    expect(telegram.answerCallback).toHaveBeenCalledWith('cb-1', messagesFor('en').recheck.startedToast);
    expect(telegram.showWorking).toHaveBeenCalledWith('42', 7, 'recheck', 'en');
    const [, , text, options] = telegram.editMessage.mock.calls[0]! as unknown as [string, number, string, { keyboard: string }];
    expect(text).toContain('Re-checked (15:00): no new proposal. The agent: Above where it was worth buying.');
    expect(options.keyboard).toBe('none');
  });

  it('opened from /pending, its outcome keeps the way back to the list (D281)', async () => {
    const telegram = chat();
    await tap(telegram, undefined, 'en', memoryRateLimits(), true);
    const [, , , options] = telegram.editMessage.mock.calls[0]! as unknown as [string, number, string, { backToPending: boolean }];
    expect(options.backToPending).toBe(true);
  });

  it("counts with the page's limit and, once it is spent, says when to try again and keeps the button (D257)", async () => {
    const rateLimits = memoryRateLimits();
    for (let point = 0; point < RATE_LIMITS.proposalRecheck.points; point += 1) {
      await rateLimits.take('proposalRecheck', userKey(USER.id));
    }
    const telegram = chat();
    const ai = fakeAi(async () => SCAN);
    await tap(telegram, ai, 'he', rateLimits);
    const [, toast] = telegram.answerCallback.mock.calls[0]! as unknown as [string, string];
    expect(toast).toBe(messagesFor('he').rateLimited(minutesOf(RATE_LIMITS.proposalRecheck.durationSeconds)));
    expect(ai.recheckProposal).not.toHaveBeenCalled();
    expect(telegram.setKeyboard).not.toHaveBeenCalled();
    expect(telegram.showWorking).not.toHaveBeenCalled();
  });

  it('keeps the button when the re-check reached no answer', async () => {
    const telegram = chat();
    await tap(telegram, fakeAi(async () => ({ ...SCAN, outcome: 'cap_reached', answer: null })));
    const [, , text, options] = telegram.editMessage.mock.calls[0]! as unknown as [string, number, string, { keyboard: string }];
    expect(text).toContain(`${messagesFor('en').recheck.causes.cap_reached} You can try again.`);
    expect(options.keyboard).toBe('recheck');
  });

  it('says a refusal before any model call in the line, keeping the button when it may pass later', async () => {
    const telegram = chat();
    const ai = fakeAi(async () => {
      throw new AiServiceError('refused', 409, { detail: { code: 'budget_spent', message: 'spent' } });
    });
    await tap(telegram, ai, 'he');
    const [, , text, options] = telegram.editMessage.mock.calls[0]! as unknown as [string, number, string, { keyboard: string }];
    expect(text).toContain(messagesFor('he').recheck.refusals.budget_spent);
    expect(options.keyboard).toBe('recheck');
  });

  it('answers a tap on a proposal already re-checked without asking the AI service', async () => {
    latest = scanRow();
    const telegram = chat();
    const ai = fakeAi(async () => SCAN);
    await tap(telegram, ai);
    expect(telegram.answerCallback).toHaveBeenCalledWith('cb-1', messagesFor('en').recheck.refusals.already_rechecked);
    expect(telegram.setKeyboard).toHaveBeenCalledWith('42', 7, PROPOSAL, 'none', 'en', { backToPending: false });
    expect(ai.recheckProposal).not.toHaveBeenCalled();
  });

  it('a refusal on a message opened from /pending keeps the way back (D281)', async () => {
    latest = scanRow();
    const telegram = chat();
    await tap(telegram, undefined, 'en', memoryRateLimits(), true);
    expect(telegram.setKeyboard).toHaveBeenCalledWith('42', 7, PROPOSAL, 'none', 'en', { backToPending: true });
  });

  it('answers a tap on a superseded proposal with why, and takes the button away (D218)', async () => {
    later = 'p-later';
    const telegram = chat();
    const ai = fakeAi(async () => SCAN);
    await tap(telegram, ai, 'he');
    expect(telegram.answerCallback).toHaveBeenCalledWith('cb-1', messagesFor('he').recheck.refusals.superseded);
    expect(telegram.setKeyboard).toHaveBeenCalledWith('42', 7, PROPOSAL, 'none', 'he', { backToPending: false });
    expect(ai.recheckProposal).not.toHaveBeenCalled();
  });

  it('says every outcome in both languages', () => {
    const results: RecheckResult[] = [
      { outcome: 'proposed', scanId: 's', at: '', proposalId: 'p' },
      { outcome: 'declined', scanId: 's', at: '', reason: { kind: 'check', check: 'cash' } },
      { outcome: 'unanswered', scanId: 's', at: '', cause: 'own_key_failed' },
    ];
    for (const language of ['en', 'he']) {
      for (const result of results) expect(recheckLine(result, '15:00', messagesFor(language))).not.toBe('');
    }
    expect(recheckLine(results[1]!, '15:00', messagesFor('en'))).toContain('does not have the cash');
  });
});

