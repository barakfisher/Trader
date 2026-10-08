/**
 * Agents' scheduled scans (D68-D74): what the 15-minute plan puts on the
 * queue, and what one attempt records. The database is mocked and the AI
 * service faked; the queue is a recorder. Slot timing itself is pinned in
 * scanSchedule.test.ts, the SQL of a slot's history in queries.postgres.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AiServiceError } from '@traders/shared/ai';

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
    scan_schedule: 'pre_open',
    ...overrides,
  };
}

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
  listSlotAttempts: vi.fn(async () => attempts),
  claimRun: vi.fn(async () => ({ claimed: true, runId: 'run-1' })),
  finishRun: vi.fn(async () => undefined),
  getOrCreateUserSettings: vi.fn(async () => ({ language: 'en' })),
  getUser: vi.fn(async () => ({ id: USER, email: null, base_currency: 'USD', timezone: 'Asia/Jerusalem' })),
  primaryAgentId: vi.fn(async () => 'primary'),
}));

vi.mock('../src/services/tradeProposals.js', () => ({
  proposeFromScan: vi.fn(async () => null),
}));

const queries = await import('../src/db/queries.js');
const scheduled = await import('../src/services/scheduledScans.js');
const { MAX_SLOT_ATTEMPTS, RETRY_AFTER_MS, nextAttempt, planScheduledScans, runSlotAttempt } = scheduled;

const SCAN = { scan_id: 's-1', outcome: 'no_trade', steps: 2, cost_micro_usd: 30_000, model: 'm', answer: null, error: null };

function fakeAi(scan: () => Promise<unknown> = async () => SCAN) {
  return {
    marketSessions: vi.fn(async () => ({ exchange: 'NMS', calendar: 'XNYS', sessions: [SESSION] })),
    scanAgent: vi.fn(scan),
  } as never as import('@traders/shared/ai').AiClient & { scanAgent: ReturnType<typeof vi.fn> };
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
    const result = await planScheduledScans({ userId: USER, ai, queue, now: NOW });
    expect(result).toEqual({ agents: 1, due: 1, enqueued: 1 });
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
    expect(await planScheduledScans({ userId: USER, ai: fakeAi(), queue, now: NOW })).toEqual({ agents: 1, due: 1, enqueued: 0 });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('asks nothing of the calendar when no agent can scan', async () => {
    vi.mocked(queries.listAgents).mockResolvedValueOnce([agentRow({ persona: null }), agentRow({ state: 'paused' })] as never);
    const ai = fakeAi();
    expect(await planScheduledScans({ userId: USER, ai, queue: { add: vi.fn() }, now: NOW })).toEqual({ agents: 0, due: 0, enqueued: 0 });
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

  it('records an attempt that reached the worker after its window, without scanning', async () => {
    const ai = fakeAi();
    await runSlotAttempt(job, { ai, notifier: notifier(), now: () => new Date('2026-10-08T20:05:00Z') });
    expect(ai.scanAgent).not.toHaveBeenCalled();
    expect(queries.finishRun).toHaveBeenCalledWith('run-1', 'skipped', { reason: 'window_closed' });
  });
});

describe('the ask, through POST /internal/runs (D71)', () => {
  const ENV = {
    APP_ENV: 'test',
    LOG_LEVEL: 'error',
    APP_PASSPHRASE: 'test-passphrase',
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

  it('claims its 15-minute run and plans where they are on', async () => {
    const queue = { add: vi.fn(async () => undefined) };
    const response = await ask(queue);
    expect(await response.json()).toMatchObject({ status: 'ok', result: { agents: 1 } });
    expect(queries.claimRun).toHaveBeenCalledWith(expect.objectContaining({ kind: 'agent_scans', agentId: 'primary' }));
  });
});

describe('the settings', () => {
  it('schedule nothing unless ENABLE_SCHEDULED_SCANS is exactly true', async () => {
    const { loadConfig, resetConfigForTests } = await import('../src/config.js');
    const base = {
      APP_PASSPHRASE: 'test-passphrase',
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
