/**
 * Agents' scheduled scans (D68-D74): what the 15-minute plan puts on the
 * queue, and what one attempt records. The database is mocked and the AI
 * service faked; the queue is a recorder. Slot timing itself is pinned in
 * scanSchedule.test.ts, the SQL of a slot's history in queries.postgres.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PAYER_REFUSALS } from '@traders/shared';
import { AiServiceError } from '@traders/shared/ai';
import { ACTIVE_SESSION } from './session.js';

const USER = '00000000-0000-0000-0000-000000000001';
const AGENT = '90000000-0000-0000-0000-0000000000a1';
// 2026-10-08, 13:10 UTC: ten minutes into the pre-open slot (09:00 New York).
const NOW = new Date('2026-10-08T13:10:00Z');
const SESSION = { day: '2026-10-08', opens_at: '2026-10-08T13:30:00Z', closes_at: '2026-10-08T20:00:00Z', early_close: false };

function agentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT,
    name: 'Value',
    persona: 'Patient.',
    is_primary: false,
    state: 'active',
    scan_every_hours: null,
    scan_pre_open: true,
    scan_post_close: false,
    ...overrides,
  };
}

const SETTINGS = {
  language: 'en',
  notify_severity: 'high',
  quiet_hours_start: null,
  quiet_hours_end: null,
  muted_until: null,
};

let attempts: { run_key: string; status: string; finished_at: Date | null; stats: Record<string, unknown> }[] = [];

vi.mock('../src/db/pool.js', () => ({
  queryOne: vi.fn(async () => null),
  query: vi.fn(async () => []),
  transaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({})),
  initPool: vi.fn(),
  getPool: vi.fn(),
  closePool: vi.fn(),
}));

vi.mock('../src/db/queries.js', () => ({
  listAgents: vi.fn(async () => [agentRow({ id: 'primary', is_primary: true, persona: null }), agentRow()]),
  getAgent: vi.fn(async () => agentRow()),
  listActiveUserIds: vi.fn(async () => [USER]),
  listSlotAttempts: vi.fn(async () => attempts),
  listActiveResearchAssignments: vi.fn(async () => []),
  claimRun: vi.fn(async () => ({ claimed: true, runId: 'run-1' })),
  finishRun: vi.fn(async () => undefined),
  getOrCreateUserSettings: vi.fn(async () => SETTINGS),
  getUser: vi.fn(async () => ({ id: USER, email: null, base_currency: 'USD', timezone: 'Asia/Jerusalem', status: 'active' })),
  primaryAgentId: vi.fn(async () => 'primary'),
  // The give-up alert's ledger (D298): every claim wins unless a test says otherwise.
  claimNotification: vi.fn(async () => ({ id: 'n-1' })),
  settleNotification: vi.fn(async () => undefined),
}));

vi.mock('../src/services/tradeProposals.js', () => ({
  proposeFromScan: vi.fn(async () => null),
}));

const queries = await import('../src/db/queries.js');
const scheduled = await import('../src/services/scheduledScans.js');
const { USER_NOT_ACTIVE } = await import('../src/services/scheduledResearch.js');
const { MAX_SLOT_ATTEMPTS, RETRY_AFTER_MS, nextAttempt, planScheduledScans, roundRobin, runSlotAttempt } = scheduled;

const SCAN = { scan_id: 's-1', outcome: 'no_trade', steps: 2, cost_micro_usd: 30_000, model: 'm', answer: null, error: null };

function fakeAi(scan: () => Promise<unknown> = async () => SCAN) {
  return {
    marketSessions: vi.fn(async () => ({ exchange: 'NMS', calendar: 'XNYS', sessions: [SESSION] })),
    scanAgent: vi.fn(scan),
    startResearch: vi.fn(async () => ({ run_id: 'research-run-1', agent_id: AGENT, holdings: 3 })),
  } as never as import('@traders/shared/ai').AiClient & {
    scanAgent: ReturnType<typeof vi.fn>;
    startResearch: ReturnType<typeof vi.fn>;
  };
}

const notifier = () => ({ channel: 'telegram', send: vi.fn(async () => ({ delivered: true })) });

const failedAt = (minutesAgo: number, retryable = true) => ({
  run_key: 'k',
  status: 'failed',
  finished_at: new Date(NOW.getTime() - minutesAgo * 60_000),
  stats: { retryable },
});

beforeEach(() => {
  vi.clearAllMocks();
  attempts = [];
});

describe('the next attempt at a slot (D69)', () => {
  const slot = { until: new Date('2026-10-08T20:00:00Z') };

  it('is the first when none ran, and nothing while one is running', () => {
    expect(nextAttempt([], slot, NOW)).toBe(1);
    expect(nextAttempt([{ run_key: 'k', status: 'running', finished_at: null, stats: {} }], slot, NOW)).toBeNull();
  });

  it('is nothing after an answer: a scan that ran, a refused answer, a spent budget', () => {
    for (const status of ['ok', 'degraded', 'skipped']) {
      expect(nextAttempt([{ run_key: 'k', status, finished_at: NOW, stats: {} }], slot, NOW), status).toBeNull();
    }
    expect(nextAttempt([failedAt(120, false)], slot, NOW)).toBeNull();
  });

  it('retries a failure an hour later at the soonest, and at most twice', () => {
    expect(nextAttempt([failedAt(59)], slot, NOW)).toBeNull();
    expect(nextAttempt([failedAt(RETRY_AFTER_MS / 60_000)], slot, NOW)).toBe(2);
    expect(nextAttempt([failedAt(200), failedAt(120)], slot, NOW)).toBe(3);
    expect(nextAttempt(Array.from({ length: MAX_SLOT_ATTEMPTS }, () => failedAt(120)), slot, NOW)).toBeNull();
  });

  it('is nothing once the window has closed', () => {
    expect(nextAttempt([], { until: NOW }, NOW)).toBeNull();
  });
});

describe('the 15-minute plan', () => {
  it("queues the due slot of each active agent with a persona, keyed by its attempt's run key", async () => {
    const queue = { add: vi.fn(async () => undefined) };
    const ai = fakeAi();
    const result = await planScheduledScans({ userIds: [USER], ai, queue, now: NOW });
    expect(result).toEqual({ users: 1, agents: 1, due: 1, enqueued: 1 });
    expect(queue.add).toHaveBeenCalledWith(`agent_scan:${AGENT}:2026-10-08:pre_open:1`, {
      userId: USER,
      agentId: AGENT,
      day: '2026-10-08',
      slot: 'pre_open',
      attempt: 1,
      until: '2026-10-08T20:00:00.000Z',
    });
  });

  it('queues nothing for a slot that already has its answer', async () => {
    attempts = [{ run_key: 'k', status: 'ok', finished_at: NOW, stats: {} }];
    const queue = { add: vi.fn(async () => undefined) };
    expect(await planScheduledScans({ userIds: [USER], ai: fakeAi(), queue, now: NOW })).toEqual({ users: 1, agents: 1, due: 1, enqueued: 0 });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('plans an agent with settings and no instructions (D174)', async () => {
    vi.mocked(queries.listAgents).mockResolvedValueOnce([agentRow({ persona: null, horizon: 'long' })] as never);
    const ai = fakeAi();
    const plan = await planScheduledScans({ userIds: [USER], ai, queue: { add: vi.fn() }, now: NOW });
    expect(plan.agents).toBe(1);
  });

  it("takes the users' attempts in turn, so one user's many agents do not go first (D161)", async () => {
    const OTHER = '00000000-0000-0000-0000-0000000000b2';
    vi.mocked(queries.listAgents)
      .mockResolvedValueOnce([agentRow({ id: 'a-1' }), agentRow({ id: 'a-2' }), agentRow({ id: 'a-3' })] as never)
      .mockResolvedValueOnce([agentRow({ id: 'b-1' })] as never);
    const added: { agentId: string; userId: string }[] = [];
    const queue = { add: vi.fn(async (_id: string, job: { agentId: string; userId: string }) => void added.push(job)) };
    const plan = await planScheduledScans({ userIds: [USER, OTHER], ai: fakeAi(), queue, now: NOW });
    expect(plan).toEqual({ users: 2, agents: 4, due: 4, enqueued: 4 });
    expect(added.map((job) => job.agentId)).toEqual(['a-1', 'b-1', 'a-2', 'a-3']);
    expect(added[1]?.userId).toBe(OTHER);
  });

  it('round-robin takes one from each list in turn', () => {
    expect(roundRobin([['a1', 'a2', 'a3'], [], ['c1', 'c2']])).toEqual(['a1', 'c1', 'a2', 'c2', 'a3']);
    expect(roundRobin([])).toEqual([]);
  });

  it('asks nothing of the calendar when no agent can scan', async () => {
    vi.mocked(queries.listAgents).mockResolvedValueOnce([agentRow({ persona: null }), agentRow({ state: 'paused' })] as never);
    const ai = fakeAi();
    expect(await planScheduledScans({ userIds: [USER], ai, queue: { add: vi.fn() }, now: NOW })).toEqual({ users: 1, agents: 0, due: 0, enqueued: 0 });
    expect(ai.marketSessions).not.toHaveBeenCalled();
  });
});

describe('one attempt', () => {
  const job = { userId: USER, agentId: AGENT, day: '2026-10-08', slot: 'pre_open' as const, attempt: 1, until: '2026-10-08T20:00:00Z' };

  it("scans on the schedule's trigger and records the answer", async () => {
    const ai = fakeAi();
    await runSlotAttempt(job, { ai, notifier: notifier(), now: () => NOW });
    expect(queries.claimRun).toHaveBeenCalledWith(expect.objectContaining({ kind: 'agent_scan', runKey: `agent_scan:${AGENT}:2026-10-08:pre_open:1`, agentId: AGENT }));
    expect(ai.scanAgent).toHaveBeenCalledWith(AGENT, { user_id: USER, trigger: 'schedule' });
    expect(queries.finishRun).toHaveBeenCalledWith('run-1', 'ok', expect.objectContaining({ outcome: 'no_trade', scanId: 's-1' }));
  });

  it('does nothing when the attempt was already claimed', async () => {
    vi.mocked(queries.claimRun).mockResolvedValueOnce({ claimed: false, runId: null });
    const ai = fakeAi();
    await runSlotAttempt(job, { ai, notifier: notifier(), now: () => NOW });
    expect(ai.scanAgent).not.toHaveBeenCalled();
  });

  it('records a provider failure as retryable, and tells nobody while retries remain', async () => {
    const ai = fakeAi(async () => {
      throw new AiServiceError('AI service 502', 502);
    });
    const channel = notifier();
    await runSlotAttempt(job, { ai, notifier: channel, now: () => NOW });
    expect(queries.finishRun).toHaveBeenCalledWith('run-1', 'failed', expect.objectContaining({ cause: 'provider_error', retryable: true }));
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('names a rate limit the scan met, and says so once when the last attempt fails (D74)', async () => {
    const ai = fakeAi(async () => ({ ...SCAN, outcome: 'failed', error: 'LLMProviderError: 429 Too Many Requests' }));
    const channel = notifier();
    await runSlotAttempt({ ...job, attempt: MAX_SLOT_ATTEMPTS }, { ai, notifier: channel, now: () => NOW });
    expect(queries.finishRun).toHaveBeenCalledWith('run-1', 'failed', expect.objectContaining({ cause: 'rate_limited' }));
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(channel.send).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "⚠️ Value's pre-open scan (2026-10-08) did not run",
        body: expect.stringContaining('the model provider is rate-limiting requests'),
      }),
    );
  });

  it('skips the scan of an account closed or disabled after the slot was queued (D316)', async () => {
    for (const status of ['closed', 'disabled'] as const) {
      vi.clearAllMocks();
      vi.mocked(queries.getUser).mockResolvedValueOnce({ id: USER, status } as never);
      const ai = fakeAi();
      await runSlotAttempt(job, { ai, notifier: notifier(), now: () => NOW });
      expect(ai.scanAgent, status).not.toHaveBeenCalled();
      expect(queries.finishRun, status).toHaveBeenCalledWith('run-1', 'skipped', { reason: USER_NOT_ACTIVE });
    }
  });

  it('records the give-up in the ledger against the run that gave up (D298)', async () => {
    const ai = fakeAi(async () => {
      throw new AiServiceError('AI service 502', 502);
    });
    await runSlotAttempt({ ...job, attempt: MAX_SLOT_ATTEMPTS }, { ai, notifier: notifier(), now: () => NOW });
    expect(queries.claimNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: AGENT,
        channel: 'telegram',
        refKind: 'run',
        refId: 'run-1',
        route: 'push',
        dedupeKey: 'telegram:run:run-1',
      }),
    );
    expect(queries.settleNotification).toHaveBeenCalledWith('n-1', 'sent');
  });

  it('holds the give-up for the digest during quiet hours (D298)', async () => {
    // 13:10 UTC is 16:10 in Jerusalem, inside a 15:00-17:00 window.
    vi.mocked(queries.getOrCreateUserSettings).mockResolvedValueOnce({
      ...SETTINGS,
      quiet_hours_start: '15:00',
      quiet_hours_end: '17:00',
    } as never);
    const channel = notifier();
    const ai = fakeAi(async () => {
      throw new AiServiceError('AI service 502', 502);
    });
    await runSlotAttempt({ ...job, attempt: MAX_SLOT_ATTEMPTS }, { ai, notifier: channel, now: () => NOW });
    expect(channel.send).not.toHaveBeenCalled();
    expect(queries.claimNotification).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'digest', refKind: 'run', reason: 'quiet_hours' }),
    );
  });

  it('holds the give-up for the digest while the user is muted (D298)', async () => {
    vi.mocked(queries.getOrCreateUserSettings).mockResolvedValueOnce({
      ...SETTINGS,
      muted_until: new Date(NOW.getTime() + RETRY_AFTER_MS),
    } as never);
    const channel = notifier();
    const ai = fakeAi(async () => {
      throw new AiServiceError('AI service 502', 502);
    });
    await runSlotAttempt({ ...job, attempt: MAX_SLOT_ATTEMPTS }, { ai, notifier: channel, now: () => NOW });
    expect(channel.send).not.toHaveBeenCalled();
    expect(queries.claimNotification).toHaveBeenCalledWith(expect.objectContaining({ channel: 'digest', reason: 'muted' }));
  });

  it('sends nothing for a give-up the ledger already holds (D298)', async () => {
    vi.mocked(queries.claimNotification).mockResolvedValueOnce(null);
    const channel = notifier();
    const ai = fakeAi(async () => {
      throw new AiServiceError('AI service 502', 502);
    });
    await runSlotAttempt({ ...job, attempt: MAX_SLOT_ATTEMPTS }, { ai, notifier: channel, now: () => NOW });
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('gives up at once when no retry can land inside the window', async () => {
    const channel = notifier();
    const ai = fakeAi(async () => {
      throw new AiServiceError('timed out', 504);
    });
    // Forty minutes before the close: an hour later the window is gone.
    await runSlotAttempt(job, { ai, notifier: channel, now: () => new Date('2026-10-08T19:20:00Z') });
    expect(queries.finishRun).toHaveBeenCalledWith('run-1', 'failed', expect.objectContaining({ cause: 'timeout' }));
    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  it('takes a spent budget or a paused agent as the answer: nothing to retry, nothing to report', async () => {
    const channel = notifier();
    const ai = fakeAi(async () => {
      throw new AiServiceError('refused', 409, { detail: { code: 'budget_spent', message: 'spent' } });
    });
    await runSlotAttempt(job, { ai, notifier: channel, now: () => NOW });
    expect(queries.finishRun).toHaveBeenCalledWith('run-1', 'skipped', { reason: 'budget_spent' });
    expect(channel.send).not.toHaveBeenCalled();
  });

  it.each(PAYER_REFUSALS)('skips a user nobody may pay for (%s), silently: D245', async (code) => {
    const channel = notifier();
    const ai = fakeAi(async () => {
      throw new AiServiceError('refused', 409, { detail: { code, message: 'no key' } });
    });
    await runSlotAttempt(job, { ai, notifier: channel, now: () => NOW });
    expect(queries.finishRun).toHaveBeenCalledWith('run-1', 'skipped', { reason: code });
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('records an attempt that reached the worker after its window, without scanning', async () => {
    const ai = fakeAi();
    await runSlotAttempt(job, { ai, notifier: notifier(), now: () => new Date('2026-10-08T20:05:00Z') });
    expect(ai.scanAgent).not.toHaveBeenCalled();
    expect(queries.finishRun).toHaveBeenCalledWith('run-1', 'skipped', { reason: 'window_closed' });
  });
});

describe('the daily research (D290)', () => {
  // 2026-10-08, 21:00 UTC: 17:00 New York, inside the post-close window.
  const AFTER_CLOSE = new Date('2026-10-08T21:00:00Z');
  const RESEARCHER = '90000000-0000-0000-0000-0000000000b1';

  it('queues one research attempt a day after the close, beside the scans', async () => {
    vi.mocked(queries.listActiveResearchAssignments).mockResolvedValueOnce([{ user_id: USER, agent_id: RESEARCHER }]);
    const queue = { add: vi.fn(async () => undefined) };
    const result = await planScheduledScans({ userIds: [USER], ai: fakeAi(), queue, now: AFTER_CLOSE });
    // The agent's pre-open slot is long past; the research's window is open.
    expect(result).toEqual({ users: 1, agents: 1, due: 1, enqueued: 1 });
    expect(queue.add).toHaveBeenCalledWith(`research:${RESEARCHER}:2026-10-08:1`, {
      kind: 'research',
      userId: USER,
      agentId: RESEARCHER,
      day: '2026-10-08',
      slot: 'post_close',
      attempt: 1,
      until: '2026-10-09T04:00:00.000Z',
    });
    expect(queries.listSlotAttempts).toHaveBeenCalledWith(RESEARCHER, `research:${RESEARCHER}:2026-10-08`, 'research');
  });

  it('queues nothing before the close', async () => {
    vi.mocked(queries.listActiveResearchAssignments).mockResolvedValueOnce([{ user_id: USER, agent_id: RESEARCHER }]);
    vi.mocked(queries.listAgents).mockResolvedValueOnce([]);
    const queue = { add: vi.fn(async () => undefined) };
    expect(await planScheduledScans({ userIds: [USER], ai: fakeAi(), queue, now: NOW })).toMatchObject({ due: 0, enqueued: 0 });
  });

  const job = {
    kind: 'research' as const,
    userId: USER,
    agentId: RESEARCHER,
    day: '2026-10-08',
    slot: 'post_close' as const,
    attempt: 1,
    until: '2026-10-09T04:00:00.000Z',
  };

  it('starts the run on the schedule trigger and records that it started', async () => {
    const ai = fakeAi();
    await runSlotAttempt(job, { ai, notifier: notifier() as never, now: () => AFTER_CLOSE });
    expect(queries.claimRun).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'research', runKey: `research:${RESEARCHER}:2026-10-08:1`, agentId: RESEARCHER }),
    );
    expect(ai.startResearch).toHaveBeenCalledWith({ user_id: USER, trigger: 'schedule' });
    expect(ai.scanAgent).not.toHaveBeenCalled();
    expect(queries.finishRun).toHaveBeenCalledWith('run-1', 'ok', { researchRunId: 'research-run-1', holdings: 3 });
  });

  it('skips the research of an account closed after the slot was queued (D316)', async () => {
    vi.mocked(queries.getUser).mockResolvedValueOnce({ id: USER, status: 'closed' } as never);
    const ai = fakeAi();
    await runSlotAttempt(job, { ai, notifier: notifier() as never, now: () => AFTER_CLOSE });
    expect(ai.startResearch).not.toHaveBeenCalled();
    expect(queries.finishRun).toHaveBeenCalledWith('run-1', 'skipped', { reason: USER_NOT_ACTIVE });
  });

  it("takes a refusal as the day's answer, and a fault as retryable", async () => {
    for (const code of ['no_holdings', 'research_running', ...PAYER_REFUSALS]) {
      vi.clearAllMocks();
      const ai = fakeAi();
      ai.startResearch.mockRejectedValueOnce(new AiServiceError(code, 409, { detail: { code, message: code } }));
      await runSlotAttempt(job, { ai, notifier: notifier() as never, now: () => AFTER_CLOSE });
      expect(queries.finishRun, code).toHaveBeenCalledWith('run-1', 'skipped', { reason: code });
    }
    vi.clearAllMocks();
    const ai = fakeAi();
    ai.startResearch.mockRejectedValueOnce(new AiServiceError('bad gateway', 502));
    await runSlotAttempt(job, { ai, notifier: notifier() as never, now: () => AFTER_CLOSE });
    expect(queries.finishRun).toHaveBeenCalledWith('run-1', 'failed', expect.objectContaining({ retryable: true }));
  });
});

describe('the ask, through POST /internal/runs (D71)', () => {
  const ENV = {
    APP_ENV: 'test',
    LOG_LEVEL: 'error',
      SESSION_SECRET: 'test-session-secret-value',
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
    AI_SERVICE_URL: 'http://ai-service:8000',
    INTERNAL_API_KEY: 'internal-test-key',
    ALLOWED_ORIGINS: 'http://localhost:5173',
  } as unknown as NodeJS.ProcessEnv;

  async function ask(queue: { add: ReturnType<typeof vi.fn> } | null) {
    const { loadConfig, resetConfigForTests } = await import('../src/config.js');
    const { createApp } = await import('../src/http/app.js');
    resetConfigForTests();
    const app = createApp(loadConfig(ENV), fakeAi(), notifier(), queue);
    return app.request('/internal/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': 'internal-test-key' },
      body: JSON.stringify({ kind: 'agent_scans', trigger: 'scheduler' }),
    });
  }

  it('is skipped, with no run written, where scheduled scans are off', async () => {
    const response = await ask(null);
    expect(await response.json()).toMatchObject({ status: 'skipped', reason: expect.stringContaining('ENABLE_SCHEDULED_SCANS') });
    expect(queries.claimRun).not.toHaveBeenCalled();
  });

  it("claims the installation's 15-minute run and plans every active user's agents (D238)", async () => {
    const queue = { add: vi.fn(async () => undefined) };
    const response = await ask(queue);
    expect(await response.json()).toMatchObject({ status: 'ok', result: { users: 1, agents: 1 } });
    expect(queries.claimRun).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'agent_scans', userId: null, agentId: null, runKey: expect.stringMatching(/^agent_scans:installation:/) }),
    );
  });
});

describe('the settings', () => {
  it('schedule nothing unless ENABLE_SCHEDULED_SCANS is exactly true', async () => {
    const { loadConfig, resetConfigForTests } = await import('../src/config.js');
    const base = {
          SESSION_SECRET: 'test-session-secret-value',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      AI_SERVICE_URL: 'http://ai-service:8000',
      INTERNAL_API_KEY: 'internal-test-key',
    };
    for (const [value, expected] of [[undefined, false], ['', false], ['false', false], ['1', false], ['true', true]] as const) {
      resetConfigForTests();
      const env = { ...base, ...(value === undefined ? {} : { ENABLE_SCHEDULED_SCANS: value }) } as unknown as NodeJS.ProcessEnv;
      expect(loadConfig(env).ENABLE_SCHEDULED_SCANS, String(value)).toBe(expected);
    }
    resetConfigForTests();
  });
});
