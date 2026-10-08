/**
 * Trade proposals (Stage 4, PR 5a): a scan's buy or sell written as a
 * proposal, and its approval - preview at the live price, confirm that fills,
 * a refusal recorded and the proposal left pending (D4, D47-D49).
 *
 * The database is an in-memory ledger, as in `fills.test.ts`; what is tested is
 * what this process decides. The SQL - the observation and proposal written
 * together, the 0044 constraints - is proven against Postgres in
 * `queries.postgres.test.ts` and `test_migrations.py`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = { id: '00000000-0000-0000-0000-000000000001', email: null, base_currency: 'USD', timezone: 'Asia/Jerusalem' };
const AGENT = '90000000-0000-0000-0000-0000000000a1';
const PROPOSAL = '50000000-0000-0000-0000-000000000001';
const SCAN = '70000000-0000-0000-0000-000000000001';
const NOW = new Date('2026-10-07T15:00:00Z');
const AGENT_PRICE = 20_000;

function agentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT,
    slug: 'agent-1',
    name: 'Value',
    persona: 'Patient.',
    is_primary: false,
    budget_minor: '100000',
    currency: 'USD',
    state: 'active',
    created_at: new Date('2026-10-05T10:00:00Z'),
    holdings_count: 0,
    cash_minor: '100000',
    ...overrides,
  };
}

function proposalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PROPOSAL,
    user_id: USER.id,
    observation_id: 'o-1',
    kind: 'buy',
    payload: { symbol: 'AAPL', quantity: '3', priceMinor: AGENT_PRICE, priceAsOf: null, currency: 'USD' },
    state: 'pending',
    expires_at: new Date(NOW.getTime() + 3_600_000),
    snoozed_until: null,
    decided_at: null,
    decided_via: null,
    created_at: NOW,
    severity: 'notable',
    subject_ref: 'instrument:AAPL',
    headline: 'Value proposes to buy 3 AAPL at 200.00',
    explanation: 'AAPL fell 3.18% to 200.00.',
    localized: {},
    evidence: {},
    agent_id: AGENT,
    agent_name: 'Value',
    agent_is_primary: false,
    scan_id: SCAN,
    ...overrides,
  };
}

/** The user's floor is `high`, as on the live install: a `notable` trade must still be pushed (D60). */
let settingsRow: Record<string, unknown> = {
  notify_severity: 'high',
  quiet_hours_start: null,
  quiet_hours_end: null,
  muted_until: null,
  language: 'en',
};

const ledger = { cash: 100_000n, fills: [] as Record<string, unknown>[], applied: true };
let proposal = proposalRow();

vi.mock('../src/db/pool.js', () => ({
  queryOne: vi.fn(async () => ({ ok: 1 })),
  query: vi.fn(async () => []),
  transaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({})),
  initPool: vi.fn(),
  getPool: vi.fn(),
  closePool: vi.fn(),
}));

vi.mock('../src/db/queries.js', () => ({
  transaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({})),
  getAgent: vi.fn(async () => agentRow()),
  findProposal: vi.fn(async () => proposal),
  findTradableInstrument: vi.fn(async (symbol: string) =>
    symbol.trim().toUpperCase() === 'AAPL'
      ? { id: 'i-aapl', symbol: 'AAPL', name: 'Apple', asset_class: 'equity', exchange: 'NMS', currency: 'USD', membership: 'screened' }
      : null,
  ),
  getAgentCash: vi.fn(async () => ({ balance_minor: ledger.cash.toString(), currency: 'USD', updated_at: NOW })),
  lockAgentCash: vi.fn(async () => ledger.cash),
  getAgentHoldingQuantity: vi.fn(async () => null),
  lockAgentHolding: vi.fn(async () => null),
  setAgentHolding: vi.fn(async () => undefined),
  findFillByKey: vi.fn(async (_u: string, _a: string, key: string) =>
    ledger.fills.find((fill) => fill.idempotency_key === key) ?? null,
  ),
  insertFill: vi.fn(async (_c: unknown, fill: Record<string, unknown>) => {
    const notional = fill.notionalMinor as bigint;
    ledger.cash -= notional + (fill.feeMinor as bigint);
    const id = `fill-${ledger.fills.length + 1}`;
    ledger.fills.push({
      id,
      instrument_id: fill.instrumentId,
      symbol: 'AAPL',
      side: fill.side,
      quantity: `${fill.quantity}.000000000000000000`,
      price_minor: String(fill.priceMinor),
      notional_minor: String(notional),
      fee_minor: String(fill.feeMinor),
      currency: 'USD',
      price_source: fill.priceSource,
      quote_as_of: fill.quoteAsOf ? new Date(fill.quoteAsOf as string) : null,
      quote_delay_seconds: fill.quoteDelaySeconds,
      source: fill.source,
      proposal_id: fill.proposalId,
      idempotency_key: fill.idempotencyKey,
      created_at: NOW,
    });
    return id;
  }),
  applyProposalTransitionIn: vi.fn(async () => ({ applied: ledger.applied, intentId: null })),
  applyProposalTransition: vi.fn(async () => ({ applied: true, intentId: null })),
  recordProposalAttempt: vi.fn(async () => undefined),
  createTradeProposal: vi.fn(async () => ({ proposalId: PROPOSAL, observationId: 'o-1' })),
  getUser: vi.fn(async () => USER),
  getOrCreateUserSettings: vi.fn(async () => settingsRow),
  claimNotification: vi.fn(async () => ({ id: 'n-1' })),
  settleNotification: vi.fn(async () => undefined),
}));

const { AiServiceError } = await import('@traders/shared/ai');
const queries = await import('../src/db/queries.js');
const approval = await import('../src/services/tradeApproval.js');
const tradeProposals = await import('../src/services/tradeProposals.js');
const proposals = await import('../src/services/proposals.js');
type AiClient = import('@traders/shared/ai').AiClient;
type Notifier = import('../src/notify/notifier.js').Notifier;

function stubNotifier() {
  return { channel: 'telegram', send: vi.fn(async () => ({ delivered: true })) } satisfies Notifier;
}

function stubAi(options: { open?: boolean; priceMinor?: number } = {}) {
  return {
    marketCalendar: vi.fn(async (exchange: string) => ({
      exchange,
      calendar: 'XNYS',
      as_of: NOW.toISOString(),
      is_open: options.open ?? true,
      session_closes_at: null,
      early_close: false,
      next_open: '2026-10-08T13:30:00Z',
      covered_until: '2030-12-31',
    })),
    quotes: vi.fn(async (symbols: string[]) => ({
      quotes: symbols.map((symbol) => ({
        symbol,
        price_minor: options.priceMinor ?? AGENT_PRICE,
        currency: 'USD',
        as_of: new Date(NOW.getTime() - 15 * 60_000).toISOString(),
        source: 'fake',
        delay_seconds: 900,
        previous_close_minor: null,
        day_change_pct: null,
        stale: false,
      })),
    })),
  } as unknown as AiClient;
}

const context = (options: { open?: boolean; priceMinor?: number } = {}) => ({
  ai: stubAi(options),
  timezone: USER.timezone,
  now: () => NOW,
});

async function refusal(promise: Promise<unknown>): Promise<{ status: number; code: string; details?: unknown }> {
  try {
    await promise;
  } catch (error) {
    const problem = error as { status: number; code: string; details?: unknown };
    return { status: problem.status, code: problem.code, details: problem.details };
  }
  throw new Error('expected a refusal');
}

/** A live price `bps` basis points from the agent's. */
const priceAt = (bps: number) => AGENT_PRICE + (AGENT_PRICE * bps) / 10_000;

beforeEach(() => {
  vi.clearAllMocks();
  ledger.cash = 100_000n;
  ledger.fills.length = 0;
  ledger.applied = true;
  proposal = proposalRow();
});

describe('the expiry (D4)', () => {
  it('counts from now while the market is open, and from the next open while it is closed', () => {
    const ttl = tradeProposals.TRADE_PROPOSAL_TTL_MS;
    const nextOpen = '2026-10-08T13:30:00Z';
    expect(tradeProposals.tradeProposalExpiry(NOW, { is_open: true, next_open: nextOpen })).toEqual(
      new Date(NOW.getTime() + ttl),
    );
    expect(tradeProposals.tradeProposalExpiry(NOW, { is_open: false, next_open: nextOpen })).toEqual(
      new Date(Date.parse(nextOpen) + ttl),
    );
  });
});

describe('a scan becomes a proposal', () => {
  const scan = (overrides: Record<string, unknown> = {}) =>
    ({
      scan_id: SCAN,
      outcome: 'trade',
      steps: 2,
      cost_micro_usd: 14_566,
      model: 'm',
      answer: {
        decision: 'buy',
        symbol: 'AAPL',
        quantity: '3',
        thesis: 'AAPL fell 3.18% to 200.00.',
        price_minor: AGENT_PRICE,
        price_as_of: NOW.toISOString(),
        problems: [],
      },
      error: null,
      ...overrides,
    }) as never;

  it('writes nothing for a scan that did not trade', async () => {
    const id = await tradeProposals.proposeFromScan(USER.id, agentRow() as never, scan({ outcome: 'no_trade' }), {
      ai: stubAi(),
      notifier: stubNotifier(),
    });
    expect(id).toBeNull();
    expect(queries.createTradeProposal).not.toHaveBeenCalled();
  });

  it("writes the agent's trade at its price, with the frame in every language and the thesis as written", async () => {
    const id = await tradeProposals.proposeFromScan(USER.id, agentRow() as never, scan(), {
      ai: stubAi({ open: false }),
      notifier: stubNotifier(),
      now: () => NOW,
    });
    expect(id).toBe(PROPOSAL);
    const written = vi.mocked(queries.createTradeProposal).mock.calls[0]![0];
    expect(written).toMatchObject({
      userId: USER.id,
      agentId: AGENT,
      scanId: SCAN,
      kind: 'buy',
      payload: { symbol: 'AAPL', quantity: '3', priceMinor: AGENT_PRICE, currency: 'USD' },
      headline: 'Value proposes to buy 3 AAPL at 200.00',
      thesis: 'AAPL fell 3.18% to 200.00.',
      expiresAt: new Date(Date.parse('2026-10-08T13:30:00Z') + tradeProposals.TRADE_PROPOSAL_TTL_MS),
    });
    expect(written.localized.he?.explanation).toBe('AAPL fell 3.18% to 200.00.');
    expect(written.localized.he?.headline).toContain('לקנות');
  });

  it('announces the proposal with trade buttons, above a floor it is below (D60, D61)', async () => {
    const notifier = stubNotifier();
    await tradeProposals.proposeFromScan(USER.id, agentRow() as never, scan(), {
      ai: stubAi(),
      notifier,
      now: () => NOW,
    });
    expect(queries.claimNotification).toHaveBeenCalledWith(
      expect.objectContaining({ refKind: 'observation', refId: 'o-1', route: 'push', channel: 'telegram' }),
    );
    expect(notifier.send).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalId: PROPOSAL,
        trade: true,
        title: 'Value proposes to buy 3 AAPL at 200.00',
        body: 'AAPL fell 3.18% to 200.00.',
      }),
    );
  });

  it('holds the announcement for the digest during quiet hours, and still writes the proposal', async () => {
    settingsRow = { ...settingsRow, quiet_hours_start: '00:00', quiet_hours_end: '23:59' };
    const notifier = stubNotifier();
    try {
      expect(
        await tradeProposals.proposeFromScan(USER.id, agentRow() as never, scan(), { ai: stubAi(), notifier, now: () => NOW }),
      ).toBe(PROPOSAL);
    } finally {
      settingsRow = { ...settingsRow, quiet_hours_start: null, quiet_hours_end: null };
    }
    expect(queries.claimNotification).toHaveBeenCalledWith(expect.objectContaining({ route: 'digest', reason: 'quiet_hours' }));
    expect(notifier.send).not.toHaveBeenCalled();
  });

  it('pushes a sell through quiet hours while the market is open, and holds a buy (D70)', async () => {
    settingsRow = { ...settingsRow, quiet_hours_start: '00:00', quiet_hours_end: '23:59' };
    try {
      const sell = scan({ answer: { decision: 'sell', symbol: 'AAPL', quantity: '3', thesis: 'AAPL fell 3.18% to 200.00.', price_minor: AGENT_PRICE, price_as_of: NOW.toISOString(), problems: [] } });
      await tradeProposals.proposeFromScan(USER.id, agentRow() as never, sell, { ai: stubAi({ open: true }), notifier: stubNotifier(), now: () => NOW });
      expect(queries.claimNotification).toHaveBeenLastCalledWith(expect.objectContaining({ route: 'push' }));
      // The same sell with the market shut can be approved only at the open: it waits.
      await tradeProposals.proposeFromScan(USER.id, agentRow() as never, sell, { ai: stubAi({ open: false }), notifier: stubNotifier(), now: () => NOW });
      expect(queries.claimNotification).toHaveBeenLastCalledWith(expect.objectContaining({ route: 'digest', reason: 'quiet_hours' }));
      await tradeProposals.proposeFromScan(USER.id, agentRow() as never, scan(), { ai: stubAi({ open: true }), notifier: stubNotifier(), now: () => NOW });
      expect(queries.claimNotification).toHaveBeenLastCalledWith(expect.objectContaining({ route: 'digest', reason: 'quiet_hours' }));
    } finally {
      settingsRow = { ...settingsRow, quiet_hours_start: null, quiet_hours_end: null };
    }
  });

  it('a failed announcement does not fail the scan that proposed', async () => {
    vi.mocked(queries.claimNotification).mockRejectedValueOnce(new Error('db down'));
    expect(
      await tradeProposals.proposeFromScan(USER.id, agentRow() as never, scan(), {
        ai: stubAi(),
        notifier: stubNotifier(),
        now: () => NOW,
      }),
    ).toBe(PROPOSAL);
  });

  it('reports a calendar it could not read rather than guessing the expiry', async () => {
    const ai = stubAi();
    vi.mocked(ai.marketCalendar).mockRejectedValueOnce(new AiServiceError('down', 503));
    expect(await refusal(tradeProposals.proposeFromScan(USER.id, agentRow() as never, scan(), { ai, notifier: stubNotifier() }))).toMatchObject({
      status: 503,
    });
    expect(queries.createTradeProposal).not.toHaveBeenCalled();
  });
});

describe('approve: the preview at the live price (D47)', () => {
  it("shows the trade at the live price beside the agent's, writing nothing", async () => {
    const preview = await approval.previewTradeApproval(USER.id, PROPOSAL, 'web', context({ priceMinor: priceAt(150) }));
    expect(preview).toMatchObject({ agentPriceMinor: AGENT_PRICE, distanceBps: 150 });
    expect(preview.trade.priceMinor).toBe(priceAt(150));
    expect(preview.maxDistanceBps).toBe(Number(approval.MAX_AGENT_DISTANCE_BPS));
    expect(queries.insertFill).not.toHaveBeenCalled();
    expect(queries.recordProposalAttempt).not.toHaveBeenCalled();
  });

  it("refuses beyond the agent's price either way, records the attempt, and leaves it pending (D49)", async () => {
    const max = Number(approval.MAX_AGENT_DISTANCE_BPS);
    for (const bps of [max + 1, -(max + 1)]) {
      vi.mocked(queries.recordProposalAttempt).mockClear();
      const refused = await refusal(
        approval.previewTradeApproval(USER.id, PROPOSAL, 'web', context({ priceMinor: priceAt(bps) })),
      );
      expect(refused).toMatchObject({ status: 422, code: 'price_far_from_agent' });
      expect(queries.recordProposalAttempt).toHaveBeenCalledWith(
        expect.objectContaining({
          proposalId: PROPOSAL,
          surface: 'web',
          reason: 'price_far_from_agent',
          agentPriceMinor: BigInt(AGENT_PRICE),
          livePriceMinor: BigInt(priceAt(bps)),
        }),
      );
    }
    // At the bound itself it is still shown.
    await approval.previewTradeApproval(USER.id, PROPOSAL, 'web', context({ priceMinor: priceAt(max) }));
    expect(queries.applyProposalTransition).not.toHaveBeenCalled();
  });

  it('records a closed market and a short cash balance as refused attempts too', async () => {
    expect(await refusal(approval.previewTradeApproval(USER.id, PROPOSAL, 'web', context({ open: false })))).toMatchObject({
      code: 'market_closed',
    });
    ledger.cash = 100n;
    expect(await refusal(approval.previewTradeApproval(USER.id, PROPOSAL, 'web', context()))).toMatchObject({
      code: 'insufficient_cash',
    });
    expect(vi.mocked(queries.recordProposalAttempt).mock.calls.map(([attempt]) => attempt.reason)).toEqual([
      'market_closed',
      'insufficient_cash',
    ]);
  });

  it('does not record an attempt on a proposal that is no longer open, or is not a trade', async () => {
    proposal = proposalRow({ expires_at: new Date(NOW.getTime() - 1) });
    expect(await refusal(approval.previewTradeApproval(USER.id, PROPOSAL, 'web', context()))).toMatchObject({
      code: 'expired',
    });
    proposal = proposalRow({ kind: 'rebalance', scan_id: null });
    expect(await refusal(approval.previewTradeApproval(USER.id, PROPOSAL, 'web', context()))).toMatchObject({
      code: 'not_a_trade',
    });
    expect(queries.recordProposalAttempt).not.toHaveBeenCalled();
  });
});

describe('confirm: the fill and the approval together', () => {
  it("fills as the agent's, under the proposal's key, and approves in the fill's transaction", async () => {
    const result = await approval.confirmTradeApproval(USER.id, PROPOSAL, BigInt(AGENT_PRICE), 'web', context());
    expect(result.state).toBe('approved');
    expect(queries.insertFill).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        source: 'agent',
        proposalId: PROPOSAL,
        idempotencyKey: approval.approvalKey(PROPOSAL),
        side: 'buy',
        quantity: 3n,
      }),
    );
    expect(queries.applyProposalTransitionIn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ fromState: 'pending', toState: 'approved', surface: 'web', intent: null }),
    );
  });

  it('refuses when another surface decided it first, so the fill is rolled back with it', async () => {
    ledger.applied = false;
    expect(
      await refusal(approval.confirmTradeApproval(USER.id, PROPOSAL, BigInt(AGENT_PRICE), 'web', context())),
    ).toMatchObject({ status: 409, code: 'already_decided' });
    // Losing the race is not an attempt at a price.
    expect(queries.recordProposalAttempt).not.toHaveBeenCalled();
  });

  it('records a price that moved past the range since the preview, and stays pending', async () => {
    const refused = await refusal(
      approval.confirmTradeApproval(USER.id, PROPOSAL, BigInt(AGENT_PRICE), 'web', context({ priceMinor: priceAt(100) })),
    );
    expect(refused).toMatchObject({ status: 409, code: 'price_moved' });
    expect(queries.recordProposalAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'price_moved', livePriceMinor: BigInt(priceAt(100)) }),
    );
    expect(queries.applyProposalTransitionIn).not.toHaveBeenCalled();
  });

  it('answers a repeated confirm with the fill the first one wrote', async () => {
    await approval.confirmTradeApproval(USER.id, PROPOSAL, BigInt(AGENT_PRICE), 'web', context());
    proposal = proposalRow({ state: 'approved', decided_at: NOW, decided_via: 'web' });
    const again = await approval.confirmTradeApproval(USER.id, PROPOSAL, BigInt(AGENT_PRICE), 'web', context());
    expect(again).toMatchObject({ state: 'approved', fill: { id: 'fill-1' } });
    expect(queries.insertFill).toHaveBeenCalledTimes(1);
  });
});

describe('the other decisions on a trade (D48)', () => {
  it('refuses a bare approve, a snooze and an undo, whatever the surface; a reject goes through', async () => {
    const decide = (action: 'approve' | 'reject' | 'snooze' | 'undo') =>
      proposals.applyDecision(
        { userId: USER.id, proposalId: PROPOSAL, action, surface: 'telegram', snoozeUntil: NOW },
        NOW,
      );
    expect(await decide('approve')).toMatchObject({ outcome: 'refused', reason: 'approve_with_preview' });
    expect(await decide('snooze')).toMatchObject({ outcome: 'refused', reason: 'not_for_trades' });
    expect(await decide('undo')).toMatchObject({ outcome: 'refused', reason: 'not_for_trades' });
    expect(queries.applyProposalTransition).not.toHaveBeenCalled();
    expect(await decide('reject')).toMatchObject({ outcome: 'applied', state: 'rejected' });
  });
});
