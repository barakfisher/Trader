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

import { feeMinor } from '@traders/shared';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { messagesFor } from '../src/notify/messages.js';
import { ACTIVE_SESSION } from './session.js';

const USER = { ...ACTIVE_SESSION, id: '00000000-0000-0000-0000-000000000001', email: null, base_currency: 'USD', timezone: 'Asia/Jerusalem' };
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
/** A mega-cap in Technology / Consumer Electronics, as the universe holds AAPL. */
const AAPL_PROFILE = {
  asset_class: 'equity',
  sector: 'Technology',
  industry: 'Consumer Electronics',
  category: null,
  market_cap_minor: '300000000000000',
  size_currency: 'USD',
  category_sector: null,
  industry_listed: true,
  category_listed: false,
};

const EMPTY_BOOK = { holdings_cost_minor: '0', symbol_cost_minor: '0', held_count: 0, holds_symbol: false };
let book = EMPTY_BOOK;
let proposal = proposalRow();
/** What `listHeldTradeProposals` answers: proposals held back and not yet announced (D420). */
let heldRows: Record<string, unknown>[] = [];

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
  supersedeOpenApprovals: vi.fn(async () => []),
  findTradableInstrument: vi.fn(async (symbol: string) => {
    const known = symbol.trim().toUpperCase();
    return known === 'AAPL' || known === 'MSFT'
      ? { id: `i-${known.toLowerCase()}`, symbol: known, name: known, asset_class: 'equity', exchange: 'NMS', currency: 'USD', membership: 'screened' }
      : null;
  }),
  getAgentCash: vi.fn(async () => ({ balance_minor: ledger.cash.toString(), currency: 'USD', updated_at: NOW })),
  lockAgentCash: vi.fn(async () => ledger.cash),
  getAgentHoldingQuantity: vi.fn(async () => null),
  getAgentBook: vi.fn(async () => book),
  getUniverseProfile: vi.fn(async () => AAPL_PROFILE),
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
  listScanToolCalls: vi.fn(async () => [
    { id: 'c1', name: 'get_price_history', arguments: '{"symbol":"AAPL","days":21}' },
    { id: 'c2', name: 'get_position', arguments: '{}' },
  ]),
  getUser: vi.fn(async () => USER),
  getOrCreateUserSettings: vi.fn(async () => settingsRow),
  claimNotification: vi.fn(async () => ({ id: 'n-1' })),
  listHeldTradeProposals: vi.fn(async () => heldRows),
  settleNotification: vi.fn(async () => undefined),
}));

const { AiServiceError } = await import('@traders/shared/ai');
const queries = await import('../src/db/queries.js');
const approval = await import('../src/services/tradeApproval.js');
const tradeProposals = await import('../src/services/tradeProposals.js');
const proposals = await import('../src/services/proposals.js');
type AiClient = import('@traders/shared/ai').AiClient;
type Notifier = import('../src/notify/notifier.js').Notifier;

/** The body of the first message a stub notifier was asked to send. */
function sentBody(notifier: ReturnType<typeof stubNotifier>): string {
  const calls = notifier.send.mock.calls as unknown as [{ body: string }][];
  return calls[0]![0].body;
}

function stubNotifier() {
  return { channel: 'telegram', send: vi.fn(async () => ({ delivered: true })) } satisfies Notifier;
}

function stubAi(options: { open?: boolean; priceMinor?: number; nextOpen?: string } = {}) {
  return {
    marketCalendar: vi.fn(async (exchange: string) => ({
      exchange,
      calendar: 'XNYS',
      as_of: NOW.toISOString(),
      is_open: options.open ?? true,
      session_closes_at: null,
      early_close: false,
      next_open: options.nextOpen ?? '2026-10-08T13:30:00Z',
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
  book = EMPTY_BOOK;
  heldRows = [];
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
  const trade = (overrides: Record<string, unknown> = {}) => ({
    decision: 'buy',
    symbol: 'AAPL',
    quantity: '3',
    thesis: 'AAPL fell 3.18% to 200.00.',
    price_minor: AGENT_PRICE,
    price_as_of: NOW.toISOString(),
    funded_by: [],
    refused: false,
    problems: [],
    ...overrides,
  });
  const scan = (overrides: Record<string, unknown> = {}) =>
    ({
      scan_id: SCAN,
      outcome: 'trade',
      steps: 2,
      cost_micro_usd: 14_566,
      model: 'm',
      answer: { trades: [trade()], thesis: null, problems: [] },
      error: null,
      ...overrides,
    }) as never;

  it('writes nothing for a scan that did not trade', async () => {
    const id = await tradeProposals.proposeFromScan(USER.id, agentRow() as never, scan({ outcome: 'no_trade' }), {
      ai: stubAi(),
      notifier: stubNotifier(),
    });
    expect(id).toEqual([]);
    expect(queries.createTradeProposal).not.toHaveBeenCalled();
  });

  it("writes the agent's trade at its price, with the frame in every language and the thesis as written", async () => {
    const id = await tradeProposals.proposeFromScan(USER.id, agentRow() as never, scan(), {
      ai: stubAi({ open: false }),
      notifier: stubNotifier(),
      now: () => NOW,
    });
    expect(id).toEqual([PROPOSAL]);
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
        // The thesis, what the scan checked, from its transcript, then the not-advice line (D385).
        body: `AAPL fell 3.18% to 200.00.\n\nChecked: price history AAPL (21 trading days) · position\n\n${messagesFor('en').tradeNotAdvice}`,
      }),
    );
    expect(queries.listScanToolCalls).toHaveBeenCalledWith(USER.id, agentRow().id, SCAN);
  });

  it('says the market is still closed, and when it opens in the user\'s zone, before the thesis', async () => {
    // 2026-11-09: proposed at 16:14 in Jerusalem, New York opened at 16:30 (after both clocks changed).
    const notifier = stubNotifier();
    const proposedAt = new Date('2026-11-09T14:14:30Z');
    await tradeProposals.proposeFromScan(USER.id, agentRow() as never, scan(), {
      ai: stubAi({ open: false, nextOpen: '2026-11-09T14:30:00Z' }),
      notifier,
      now: () => proposedAt,
    });
    const body = sentBody(notifier);
    expect(body.startsWith(`${messagesFor('en').tradeMarketClosed({ day: null, time: '16:30' })}\n\nAAPL fell`)).toBe(true);
    expect(messagesFor('en').tradeMarketClosed({ day: null, time: '16:30' })).toBe(
      'The market is still closed; it opens at 16:30.',
    );
  });

  it('keeps the open it waits for, and offers Approve at the open (D398)', async () => {
    const notifier = stubNotifier();
    await tradeProposals.proposeFromScan(USER.id, agentRow() as never, scan(), {
      ai: stubAi({ open: false, nextOpen: '2026-11-09T14:30:00Z' }),
      notifier,
      now: () => new Date('2026-11-09T14:14:30Z'),
    });
    expect(queries.createTradeProposal).toHaveBeenLastCalledWith(
      expect.objectContaining({ opensAt: new Date('2026-11-09T14:30:00Z') }),
    );
    const calls = notifier.send.mock.calls as unknown as [{ atOpen?: boolean }][];
    expect(calls[0]![0].atOpen).toBe(true);
  });

  it('keeps no open when the market is open, and offers Approve', async () => {
    const notifier = stubNotifier();
    await tradeProposals.proposeFromScan(USER.id, agentRow() as never, scan(), { ai: stubAi(), notifier, now: () => NOW });
    expect(queries.createTradeProposal).toHaveBeenLastCalledWith(expect.objectContaining({ opensAt: null }));
    const calls = notifier.send.mock.calls as unknown as [{ atOpen?: boolean }][];
    expect(calls[0]![0].atOpen).toBeUndefined();
  });

  it('says which approval for the open it replaced (D400)', async () => {
    vi.mocked(queries.supersedeOpenApprovals).mockResolvedValueOnce([{ id: 'older', state: 'pending', kind: 'buy' }]);
    vi.mocked(queries.findProposal).mockResolvedValueOnce({
      id: 'older',
      kind: 'buy',
      state: 'pending',
      payload: { symbol: 'AAPL', quantity: '2' },
      evidence: {},
    } as never);
    const notifier = stubNotifier();
    await tradeProposals.proposeFromScan(USER.id, agentRow() as never, scan(), {
      ai: stubAi({ open: false, nextOpen: '2026-11-09T14:30:00Z' }),
      notifier,
      now: () => new Date('2026-11-09T14:14:30Z'),
    });
    expect(queries.supersedeOpenApprovals).toHaveBeenCalledWith(USER.id, expect.any(String), 'AAPL', PROPOSAL);
    expect(sentBody(notifier)).toContain(
      messagesFor('en').openApproval.replaces({ side: 'buy', quantity: '2', symbol: 'AAPL' }),
    );
  });

  it('names the day when the market opens on a later day than the proposal', async () => {
    const notifier = stubNotifier();
    // 18:00 on Wednesday in Jerusalem; the open is Thursday 16:30 there.
    await tradeProposals.proposeFromScan(USER.id, agentRow() as never, scan(), {
      ai: stubAi({ open: false, nextOpen: '2026-10-08T13:30:00Z' }),
      notifier,
      now: () => NOW,
    });
    const body = sentBody(notifier);
    expect(body.split('\n\n')[0]).toBe('The market is still closed; it opens on Thursday at 16:30.');
  });

  it('says it in Hebrew for a Hebrew user', async () => {
    settingsRow = { ...settingsRow, language: 'he' };
    const notifier = stubNotifier();
    try {
      await tradeProposals.proposeFromScan(USER.id, agentRow() as never, scan(), {
        ai: stubAi({ open: false, nextOpen: '2026-11-09T14:30:00Z' }),
        notifier,
        now: () => new Date('2026-11-09T14:14:30Z'),
      });
    } finally {
      settingsRow = { ...settingsRow, language: 'en' };
    }
    const body = sentBody(notifier);
    expect(body.split('\n\n')[0]).toBe(messagesFor('he').tradeMarketClosed({ day: null, time: '16:30' }));
    expect(messagesFor('he').tradeMarketClosed({ day: null, time: '16:30' })).toBe('השוק עדיין סגור, ייפתח בשעה \u206616:30\u2069.');
  });

  it('holds the announcement for the digest during quiet hours, and still writes the proposal', async () => {
    settingsRow = { ...settingsRow, quiet_hours_start: '00:00', quiet_hours_end: '23:59' };
    const notifier = stubNotifier();
    try {
      expect(
        await tradeProposals.proposeFromScan(USER.id, agentRow() as never, scan(), { ai: stubAi(), notifier, now: () => NOW }),
      ).toEqual([PROPOSAL]);
    } finally {
      settingsRow = { ...settingsRow, quiet_hours_start: null, quiet_hours_end: null };
    }
    expect(queries.claimNotification).toHaveBeenCalledWith(expect.objectContaining({ route: 'digest', reason: 'quiet_hours' }));
    expect(notifier.send).not.toHaveBeenCalled();
  });

  it('pushes a sell through quiet hours while the market is open, and holds a buy (D70)', async () => {
    settingsRow = { ...settingsRow, quiet_hours_start: '00:00', quiet_hours_end: '23:59' };
    try {
      const sell = scan({ answer: { trades: [trade({ decision: 'sell' })], thesis: null, problems: [] } });
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
    ).toEqual([PROPOSAL]);
  });

  it('writes a proposal per kept trade, sells first, and names the sell a buy needs (D197)', async () => {
    vi.mocked(queries.createTradeProposal)
      .mockResolvedValueOnce({ proposalId: 'p-sell', observationId: 'o-sell' })
      .mockResolvedValueOnce({ proposalId: 'p-buy', observationId: 'o-buy' });
    const answer = {
      trades: [
        trade({ decision: 'sell', symbol: 'MSFT', quantity: '2' }),
        trade({ funded_by: ['MSFT'] }),
        trade({ symbol: 'TSLA', refused: true, problems: ['TSLA is not tradable'] }),
      ],
      thesis: null,
      problems: ['TSLA is not tradable'],
    };
    const ids = await tradeProposals.proposeFromScan(USER.id, agentRow() as never, scan({ answer }), {
      ai: stubAi(),
      notifier: stubNotifier(),
      now: () => NOW,
    });
    expect(ids).toEqual(['p-sell', 'p-buy']);
    const [sell, buy] = vi.mocked(queries.createTradeProposal).mock.calls.map(([written]) => written);
    expect(sell).toMatchObject({ kind: 'sell', payload: { symbol: 'MSFT' } });
    expect(sell!.payload.fundedBy).toBeUndefined();
    expect(buy).toMatchObject({
      kind: 'buy',
      payload: { symbol: 'AAPL', fundedBy: ['MSFT'] },
      headline: 'Value proposes to buy 3 AAPL at 200.00 - paid for by selling MSFT: approve that first',
    });
    expect(buy!.localized.he?.headline).toContain('במימון מכירת');
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

describe('the mandate at approval (D299)', () => {
  // 3 AAPL at 200.00 against $1,000.00 of cash and nothing held: 60% of capital.
  const cashAfter = 100_000 - 60_000 - Number(feeMinor('3'));
  const strict = { max_position_bps: 2_500, cash_buffer_bps: 5_000, max_holdings: 2 };

  it('names every limit the buy breaks, how far, and the setting that would allow it', async () => {
    vi.mocked(queries.getAgent).mockResolvedValueOnce(agentRow(strict) as never);
    book = { ...EMPTY_BOOK, held_count: 2 };
    const preview = await approval.previewTradeApproval(USER.id, PROPOSAL, 'web', context());
    expect(preview.mandateBreaches).toEqual([
      {
        rule: 'max_position',
        limitBps: 2_500,
        capitalMinor: 100_000,
        positionAfterMinor: 60_000,
        positionAfterBps: 6_000,
        overByMinor: 35_000,
        suggestedBps: 6_000,
      },
      {
        rule: 'cash_buffer',
        limitBps: 5_000,
        capitalMinor: 100_000,
        cashAfterMinor: cashAfter,
        cashAfterBps: Math.floor(cashAfter / 10),
        shortByMinor: 50_000 - cashAfter,
        suggestedBps: Math.floor(cashAfter / 1_000) * 100,
      },
      { rule: 'max_holdings', limit: 2, heldCount: 2, suggestedLimit: 3 },
    ]);
    expect(queries.getAgentBook).toHaveBeenCalledWith(USER.id, AGENT, 'AAPL');
    expect(queries.recordProposalAttempt).not.toHaveBeenCalled();
  });

  it('warns and never refuses: Confirm still fills past a limit', async () => {
    vi.mocked(queries.getAgent).mockResolvedValueOnce(agentRow(strict) as never);
    const result = await approval.confirmTradeApproval(USER.id, PROPOSAL, BigInt(AGENT_PRICE), 'web', context());
    expect(result.state).toBe('approved');
    expect(queries.insertFill).toHaveBeenCalledTimes(1);
  });

  it('checks no limit on a sell, and none an agent without limits has', async () => {
    vi.mocked(queries.getAgent).mockResolvedValueOnce(agentRow(strict) as never);
    proposal = proposalRow({ kind: 'sell' });
    vi.mocked(queries.getAgentHoldingQuantity).mockResolvedValueOnce('5.000000000000000000');
    expect((await approval.previewTradeApproval(USER.id, PROPOSAL, 'web', context())).mandateBreaches).toEqual([]);
    expect(queries.getAgentBook).not.toHaveBeenCalled();

    vi.mocked(queries.getAgent).mockResolvedValueOnce(agentRow() as never);
    proposal = proposalRow();
    expect((await approval.previewTradeApproval(USER.id, PROPOSAL, 'web', context())).mandateBreaches).toEqual([]);
  });
});

describe('the universe at approval (D301)', () => {
  it('warns of a symbol blocked since the scan proposed it, and still fills', async () => {
    const blocked = agentRow({ blocked_symbols: ['AAPL'] }) as never;
    // Once per call: a lasting mock would outlive clearAllMocks into later tests.
    vi.mocked(queries.getAgent).mockResolvedValueOnce(blocked).mockResolvedValueOnce(blocked);
    const preview = await approval.previewTradeApproval(USER.id, PROPOSAL, 'web', context());
    expect(preview.mandateBreaches).toEqual([{ rule: 'blocked' }]);
    expect(queries.getUniverseProfile).toHaveBeenCalledWith('AAPL');

    const result = await approval.confirmTradeApproval(USER.id, PROPOSAL, BigInt(AGENT_PRICE), 'web', context());
    expect(result.state).toBe('approved');
  });

  it('warns of a universe narrowed since, beside the size rules', async () => {
    vi.mocked(queries.getAgent).mockResolvedValueOnce(
      agentRow({ market_caps: ['mid'], sectors: ['Energy'], max_holdings: 1 }) as never,
    );
    book = { ...EMPTY_BOOK, held_count: 1 };
    const preview = await approval.previewTradeApproval(USER.id, PROPOSAL, 'web', context());
    expect(preview.mandateBreaches.map((breach) => breach.rule)).toEqual(['market_cap', 'selection', 'max_holdings']);
  });

  it('checks no universe rule on a sell', async () => {
    vi.mocked(queries.getAgent).mockResolvedValueOnce(agentRow({ blocked_symbols: ['AAPL'] }) as never);
    proposal = proposalRow({ kind: 'sell' });
    vi.mocked(queries.getAgentHoldingQuantity).mockResolvedValueOnce('5.000000000000000000');
    expect((await approval.previewTradeApproval(USER.id, PROPOSAL, 'web', context())).mandateBreaches).toEqual([]);
    expect(queries.getUniverseProfile).not.toHaveBeenCalled();
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

describe('a held proposal is announced when its hold ends (D420)', () => {
  // Jerusalem is UTC+3 on these dates, and the quiet hours are the user's on production.
  const QUIET = { quiet_hours_start: '22:00', quiet_hours_end: '07:00' };
  const RAISED = new Date('2026-10-07T20:15:00Z'); // 23:15, inside the quiet hours
  const NIGHT = new Date('2026-10-08T01:00:00Z'); // 04:00, still inside
  const MORNING = new Date('2026-10-08T04:05:00Z'); // 07:05, just after them
  const OPENS = new Date('2026-10-08T13:30:00Z'); // 16:30 the same local day
  const AFTER_OPEN = new Date('2026-10-08T14:00:00Z');
  const THESIS = 'AAPL fell 3.18% to 200.00.';

  function heldRow(overrides: Record<string, unknown> = {}) {
    return {
      proposal_id: PROPOSAL,
      user_id: USER.id,
      agent_id: AGENT,
      observation_id: 'o-1',
      kind: 'buy',
      scan_id: SCAN,
      opens_at: OPENS,
      created_at: RAISED,
      headline: 'Value proposes to buy 3 AAPL at 200.00',
      explanation: THESIS,
      localized: {},
      held_reason: 'quiet_hours',
      ...overrides,
    };
  }

  /** The line a held proposal's message begins with, as the catalogue writes it. */
  function raisedLine(language: string, reason: 'quiet_hours' | 'muted'): string {
    const messages = messagesFor(language);
    const clock = { timeZone: USER.timezone, hour: '2-digit', minute: '2-digit', hour12: false } as const;
    return messages.tradeHeld({
      day: new Intl.DateTimeFormat(messages.locale, { timeZone: USER.timezone, weekday: 'long' }).format(RAISED),
      time: new Intl.DateTimeFormat(messages.locale, clock).format(RAISED),
      reason,
    });
  }

  async function sweep(now: Date, settings: Record<string, unknown>) {
    const before = settingsRow;
    settingsRow = { ...settingsRow, ...settings };
    const notifier = stubNotifier();
    try {
      return { announced: await tradeProposals.announceHeldTradeProposals(notifier, now), notifier };
    } finally {
      settingsRow = before;
    }
  }

  it('sends it once quiet hours are over, with its buttons, saying first when it was raised', async () => {
    heldRows = [heldRow()];

    const { announced, notifier } = await sweep(MORNING, QUIET);

    expect(announced).toBe(1);
    expect(queries.listHeldTradeProposals).toHaveBeenCalledWith(notifier.channel, MORNING);
    expect(queries.claimNotification).toHaveBeenCalledWith(
      expect.objectContaining({ channel: notifier.channel, route: 'push', refKind: 'observation', refId: 'o-1' }),
    );
    expect(notifier.send).toHaveBeenCalledTimes(1);
    // Approve at the open (D398): the market it waits for has not opened yet.
    expect(notifier.send).toHaveBeenCalledWith(expect.objectContaining({ proposalId: PROPOSAL, trade: true, atOpen: true }));
    // When it was raised, when the market opens, then the message as it would have been.
    const messages = messagesFor('en');
    expect(sentBody(notifier)).toBe(
      [
        raisedLine('en', 'quiet_hours'),
        messages.tradeMarketClosed({ day: null, time: '16:30' }),
        THESIS,
        'Checked: price history AAPL (21 trading days) · position',
        messages.tradeNotAdvice,
      ].join('\n\n'),
    );
    expect(queries.listScanToolCalls).toHaveBeenCalledWith(USER.id, AGENT, SCAN);
  });

  it('leaves it held while quiet hours last, without reading its scan', async () => {
    heldRows = [heldRow()];

    const { announced, notifier } = await sweep(NIGHT, QUIET);

    expect(announced).toBe(0);
    expect(notifier.send).not.toHaveBeenCalled();
    expect(queries.claimNotification).not.toHaveBeenCalled();
    expect(queries.listScanToolCalls).not.toHaveBeenCalled();
  });

  it('leaves it held while a mute lasts, and sends it when the mute is over', async () => {
    heldRows = [heldRow({ held_reason: 'muted' })];

    const muted = await sweep(MORNING, { muted_until: new Date(MORNING.getTime() + 60_000) });
    expect(muted.announced).toBe(0);
    expect(muted.notifier.send).not.toHaveBeenCalled();

    const over = await sweep(MORNING, { muted_until: new Date(MORNING.getTime() - 60_000) });
    expect(over.announced).toBe(1);
    expect(sentBody(over.notifier).startsWith(raisedLine('en', 'muted'))).toBe(true);
  });

  it('offers plain Approve once the market it waited for has opened', async () => {
    heldRows = [heldRow({ held_reason: 'muted' })];

    const { announced, notifier } = await sweep(AFTER_OPEN, {});

    expect(announced).toBe(1);
    const [message] = notifier.send.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(message).toMatchObject({ proposalId: PROPOSAL, trade: true });
    expect(message).not.toHaveProperty('atOpen');
    expect(sentBody(notifier)).not.toContain(messagesFor('en').tradeMarketClosed({ day: null, time: '16:30' }));
  });

  it('says it in Hebrew for a Hebrew user', async () => {
    heldRows = [heldRow()];

    const { notifier } = await sweep(MORNING, { ...QUIET, language: 'he' });

    expect(sentBody(notifier).startsWith(raisedLine('he', 'quiet_hours'))).toBe(true);
  });

  it('sends nothing for a proposal another sweep already claimed on the channel', async () => {
    heldRows = [heldRow()];
    vi.mocked(queries.claimNotification).mockResolvedValueOnce(null);

    const { announced, notifier } = await sweep(MORNING, QUIET);

    expect(announced).toBe(0);
    expect(notifier.send).not.toHaveBeenCalled();
  });

  it('names no day for a proposal raised earlier the same day', async () => {
    // 00:30 in Jerusalem on the morning it is announced.
    heldRows = [heldRow({ created_at: new Date('2026-10-07T21:30:00Z') })];

    const { notifier } = await sweep(MORNING, QUIET);

    const line = messagesFor('en').tradeHeld({ day: null, time: '00:30', reason: 'quiet_hours' });
    expect(line).toBe('Proposed at 00:30, during your quiet hours.');
    expect(sentBody(notifier).startsWith(`${line}\n\n`)).toBe(true);
  });

  it("reads each proposal by its own user's settings, and sends it to that user only", async () => {
    const OTHER = '00000000-0000-0000-0000-000000000002';
    const OTHER_AGENT = '90000000-0000-0000-0000-0000000000b2';
    heldRows = [
      heldRow(),
      heldRow({ proposal_id: 'p-2', observation_id: 'o-2', scan_id: 's-2', user_id: OTHER, agent_id: OTHER_AGENT }),
    ];
    // The first user is still muted; the other is not, reads Hebrew and lives in New York.
    vi.mocked(queries.getOrCreateUserSettings).mockImplementation((async (userId: string) => ({
      ...settingsRow,
      ...(userId === OTHER ? { language: 'he' } : { muted_until: new Date(MORNING.getTime() + 60_000) }),
    })) as never);
    vi.mocked(queries.getUser).mockImplementation((async (userId: string) => ({
      ...USER,
      id: userId,
      timezone: userId === OTHER ? 'America/New_York' : USER.timezone,
    })) as never);
    const notifier = stubNotifier();
    try {
      expect(await tradeProposals.announceHeldTradeProposals(notifier, MORNING)).toBe(1);
    } finally {
      vi.mocked(queries.getOrCreateUserSettings).mockImplementation(async () => settingsRow as never);
      vi.mocked(queries.getUser).mockImplementation(async () => USER as never);
    }

    expect(notifier.send).toHaveBeenCalledTimes(1);
    expect(notifier.send).toHaveBeenCalledWith(expect.objectContaining({ userId: OTHER, proposalId: 'p-2', language: 'he' }));
    expect(queries.claimNotification).toHaveBeenCalledTimes(1);
    expect(queries.claimNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: OTHER, agentId: OTHER_AGENT, refId: 'o-2' }),
    );
    // Its own scan's checks, and its own clock: 16:15 on Wednesday in New York.
    expect(queries.listScanToolCalls).toHaveBeenCalledTimes(1);
    expect(queries.listScanToolCalls).toHaveBeenCalledWith(OTHER, OTHER_AGENT, 's-2');
    const messages = messagesFor('he');
    expect(sentBody(notifier).startsWith(messages.tradeHeld({ day: null, time: '16:15', reason: 'quiet_hours' }))).toBe(false);
    const newYork = { timeZone: 'America/New_York' } as const;
    expect(
      sentBody(notifier).startsWith(
        messages.tradeHeld({
          day: new Intl.DateTimeFormat(messages.locale, { ...newYork, weekday: 'long' }).format(RAISED),
          time: new Intl.DateTimeFormat(messages.locale, { ...newYork, hour: '2-digit', minute: '2-digit', hour12: false }).format(RAISED),
          reason: 'quiet_hours',
        }),
      ),
    ).toBe(true);
  });

  it('keeps a sell raised into an open market urgent: a mute that ends in quiet hours does not hold it (D70)', async () => {
    heldRows = [heldRow({ kind: 'sell', opens_at: null, held_reason: 'muted' })];
    const sell = await sweep(NIGHT, QUIET);
    expect(sell.announced).toBe(1);

    // A buy, or a sell that waits for an open, has nothing to gain from waking anyone.
    heldRows = [heldRow({ kind: 'buy', opens_at: null, held_reason: 'muted' }), heldRow({ kind: 'sell', held_reason: 'muted' })];
    const others = await sweep(NIGHT, QUIET);
    expect(others.announced).toBe(0);
    expect(others.notifier.send).not.toHaveBeenCalled();
  });

  it('answers nothing, and does not throw, when the held proposals cannot be listed', async () => {
    vi.mocked(queries.listHeldTradeProposals).mockRejectedValueOnce(new Error('database unreachable'));

    const { announced, notifier } = await sweep(MORNING, QUIET);

    expect(announced).toBe(0);
    expect(notifier.send).not.toHaveBeenCalled();
  });

  it("goes on to the next user's proposal when one cannot be read", async () => {
    heldRows = [heldRow(), heldRow({ proposal_id: 'p-2', observation_id: 'o-2' })];
    vi.mocked(queries.getOrCreateUserSettings).mockRejectedValueOnce(new Error('settings unreadable'));

    const { announced, notifier } = await sweep(MORNING, QUIET);

    expect(announced).toBe(1);
    expect(notifier.send).toHaveBeenCalledWith(expect.objectContaining({ proposalId: 'p-2' }));
  });
});
