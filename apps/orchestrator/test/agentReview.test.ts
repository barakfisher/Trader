/**
 * The agent review's rules and its hook after a scan (D340-D343).
 *
 * The rules are pure and run on hand-built windows; thresholds are read from
 * their constants, so retuning one breaks no test here. The hook runs against
 * mocked queries: only a scan that closes a window reviews, a window is keyed
 * by its last scan, and a failure never escapes into the scan.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReviewInput, ReviewedAgent } from '../src/services/agentReview.js';

vi.mock('../src/db/queries.js', () => ({
  readReviewWindow: vi.fn(),
  insertSuggestions: vi.fn(async (_u: string, _a: string, rows: unknown[]) => rows.map((_row, index) => `s-${index}`)),
  listCashTimeline: vi.fn(async () => []),
  listFillsOldestFirst: vi.fn(async () => []),
  findInstrumentsBySymbols: vi.fn(async () => []),
}));

const queries = await import('../src/db/queries.js');
const review = await import('../src/services/agentReview.js');
const {
  BENCHMARK_LAG_POINTS,
  COUNTED_SCAN_OUTCOMES,
  FEE_DRAG_SHARE_BPS,
  IDLE_CASH_SHARE_BPS,
  IDLE_MAX_TRADE_SCANS,
  MAX_POSITION_LIMIT_BPS,
  MAX_RISK_LEVEL,
  reviewAgent,
  reviewAfterScan,
  suggestionKey,
} = review;
const { AGENT_REVIEW_EVERY_SCANS, MAX_SCAN_EVERY_HOURS, MIN_DECISIONS_PER_SCAN } = await import('@traders/shared');

const DEPOSITS = 100_000n;
const SINCE = new Date('2026-10-19T13:00:00Z');

const agentSettings = (overrides: Partial<ReviewedAgent> = {}): ReviewedAgent => ({
  currency: 'USD',
  cash_buffer_bps: null,
  market_caps: [],
  risk_level: null,
  max_decisions: MIN_DECISIONS_PER_SCAN,
  scan_every_hours: null,
  max_position_bps: null,
  allow_etfs: true,
  ...overrides,
});

/** A window on the edge of nothing: no rule fires on it. */
const quietWindow = (overrides: Partial<ReviewInput['window']> = {}): ReviewInput['window'] => ({
  scans: AGENT_REVIEW_EVERY_SCANS,
  tradeScans: IDLE_MAX_TRADE_SCANS + 1,
  since: SINCE,
  fills: 0,
  feesMinor: 0n,
  depositsMinor: DEPOSITS,
  cashMinor: 0n,
  ...overrides,
});

/** The cash or fees that are exactly `bps` of the deposits. */
const shareOfDeposits = (bps: number) => (DEPOSITS * BigInt(bps)) / 10_000n;

const comparison = (differencePts: number) => ({
  day: '2026-10-26',
  depositsMinor: Number(DEPOSITS),
  netWorthMinor: 95_000,
  pnlMinor: -5_000,
  returnPct: 1,
  benchmarkMinor: 100_000,
  benchmarkPnlMinor: 0,
  benchmarkReturnPct: 1 - differencePts,
  differencePts,
});

describe('idle_cash', () => {
  const idle = (agent = agentSettings()) =>
    reviewAgent({
      agent,
      window: quietWindow({ tradeScans: IDLE_MAX_TRADE_SCANS, cashMinor: shareOfDeposits(IDLE_CASH_SHARE_BPS) }),
      comparison: null,
    });

  it('fires at the threshold, with the cash, deposits and their share as evidence', () => {
    const [finding] = idle();
    expect(finding).toMatchObject({
      rule: 'idle_cash',
      evidence: {
        scans: AGENT_REVIEW_EVERY_SCANS,
        tradeScans: IDLE_MAX_TRADE_SCANS,
        since: SINCE.toISOString(),
        currency: 'USD',
        cashMinor: Number(shareOfDeposits(IDLE_CASH_SHARE_BPS)),
        depositsMinor: Number(DEPOSITS),
        cashShareBps: IDLE_CASH_SHARE_BPS,
      },
    });
  });

  it('does not fire below the cash share, or when more scans traded', () => {
    const below = quietWindow({ tradeScans: IDLE_MAX_TRADE_SCANS, cashMinor: shareOfDeposits(IDLE_CASH_SHARE_BPS) - 1n });
    expect(reviewAgent({ agent: agentSettings(), window: below, comparison: null })).toEqual([]);
    const traded = quietWindow({ cashMinor: DEPOSITS });
    expect(reviewAgent({ agent: agentSettings(), window: traded, comparison: null })).toEqual([]);
  });

  it('never fires without deposits or a cash row: nothing to measure against', () => {
    const none = quietWindow({ tradeScans: 0, depositsMinor: 0n, cashMinor: 0n });
    expect(reviewAgent({ agent: agentSettings(), window: none, comparison: null })).toEqual([]);
    const noCash = quietWindow({ tradeScans: 0, cashMinor: null });
    expect(reviewAgent({ agent: agentSettings(), window: noCash, comparison: null })).toEqual([]);
  });

  it('halves a cash buffer first, to a whole percent', () => {
    expect(idle(agentSettings({ cash_buffer_bps: 2_500, market_caps: ['mega'] }))[0]!.change).toEqual({
      setting: 'cash_buffer_bps',
      from: 2_500,
      to: 1_200,
    });
  });

  it('then adds the next smaller company size', () => {
    expect(idle(agentSettings({ market_caps: ['mega', 'large'] }))[0]!.change).toEqual({
      setting: 'market_caps',
      from: ['mega', 'large'],
      to: ['mega', 'large', 'mid'],
    });
  });

  it('then raises risk one step, and with nothing left only reports', () => {
    expect(idle(agentSettings({ market_caps: ['mega', 'large', 'mid', 'small'], risk_level: 3 }))[0]!.change).toEqual({
      setting: 'risk_level',
      from: 3,
      to: 4,
    });
    expect(idle(agentSettings({ risk_level: MAX_RISK_LEVEL }))[0]!.change).toBeNull();
  });
});

describe('fee_drag', () => {
  const fees = (agent = agentSettings(), feesMinor = shareOfDeposits(FEE_DRAG_SHARE_BPS)) =>
    reviewAgent({ agent, window: quietWindow({ fills: 3, feesMinor }), comparison: null });

  it('fires at the threshold, with the fees, the fills and their share as evidence', () => {
    expect(fees()[0]).toMatchObject({
      rule: 'fee_drag',
      evidence: { fills: 3, feesMinor: Number(shareOfDeposits(FEE_DRAG_SHARE_BPS)), feeShareBps: FEE_DRAG_SHARE_BPS },
    });
    expect(fees(agentSettings(), shareOfDeposits(FEE_DRAG_SHARE_BPS) - 1n)).toEqual([]);
  });

  it('proposes one decision less per scan first', () => {
    expect(fees(agentSettings({ max_decisions: 3, scan_every_hours: 1 }))[0]!.change).toEqual({
      setting: 'max_decisions',
      from: 3,
      to: 2,
    });
  });

  it('then half as many market-hours scans, no further apart than the most allowed', () => {
    expect(fees(agentSettings({ scan_every_hours: 1 }))[0]!.change).toEqual({ setting: 'scan_every_hours', from: 1, to: 2 });
    expect(fees(agentSettings({ scan_every_hours: MAX_SCAN_EVERY_HOURS - 1 }))[0]!.change).toEqual({
      setting: 'scan_every_hours',
      from: MAX_SCAN_EVERY_HOURS - 1,
      to: MAX_SCAN_EVERY_HOURS,
    });
  });

  it('then larger positions, capped at all of capital; with nothing left only reports', () => {
    expect(fees(agentSettings({ max_position_bps: 1_800 }))[0]!.change).toEqual({
      setting: 'max_position_bps',
      from: 1_800,
      to: 2_700,
    });
    expect(fees(agentSettings({ max_position_bps: MAX_POSITION_LIMIT_BPS - 1 }))[0]!.change).toMatchObject({
      to: MAX_POSITION_LIMIT_BPS,
    });
    expect(fees(agentSettings())[0]!.change).toBeNull();
  });
});

describe('benchmark_lag', () => {
  it('fires at the margin with the comparison as evidence, and allows ETFs when they are off', () => {
    const [finding] = reviewAgent({
      agent: agentSettings({ allow_etfs: false }),
      window: quietWindow(),
      comparison: comparison(-BENCHMARK_LAG_POINTS),
    });
    expect(finding).toMatchObject({
      rule: 'benchmark_lag',
      evidence: { differencePts: -BENCHMARK_LAG_POINTS, day: '2026-10-26' },
      change: { setting: 'allow_etfs', from: false, to: true },
    });
  });

  it('only reports when ETFs are allowed, and is silent inside the margin or without a comparison', () => {
    const at = reviewAgent({ agent: agentSettings(), window: quietWindow(), comparison: comparison(-BENCHMARK_LAG_POINTS) });
    expect(at[0]!.change).toBeNull();
    const inside = comparison(-BENCHMARK_LAG_POINTS + 0.01);
    expect(reviewAgent({ agent: agentSettings(), window: quietWindow(), comparison: inside })).toEqual([]);
    expect(reviewAgent({ agent: agentSettings(), window: quietWindow(), comparison: null })).toEqual([]);
    const unpriced = { ...comparison(-BENCHMARK_LAG_POINTS), differencePts: null };
    expect(reviewAgent({ agent: agentSettings(), window: quietWindow(), comparison: unpriced })).toEqual([]);
  });
});

describe('the review after a scan', () => {
  const AGENT = { id: 'agent-1', is_primary: false, ...agentSettings({ market_caps: ['mega'] }) };
  const ai = {} as never;
  const windowRow = (counted: number) => ({
    counted: String(counted),
    scans: String(AGENT_REVIEW_EVERY_SCANS),
    trade_scans: '0',
    since: SINCE,
    last_scan_id: 'scan-10',
    fills: '0',
    fees_minor: '0',
    deposits_minor: String(DEPOSITS),
    cash_minor: String(DEPOSITS),
  });

  beforeEach(() => vi.clearAllMocks());

  it('reviews only when the counted scans close a window', async () => {
    vi.mocked(queries.readReviewWindow).mockResolvedValue(windowRow(AGENT_REVIEW_EVERY_SCANS - 1));
    expect(await reviewAfterScan('user-1', AGENT, { ai })).toEqual([]);
    expect(queries.insertSuggestions).not.toHaveBeenCalled();
    expect(queries.readReviewWindow).toHaveBeenCalledWith('user-1', 'agent-1', COUNTED_SCAN_OUTCOMES, AGENT_REVIEW_EVERY_SCANS);
  });

  it('keys each suggestion by the window\'s last scan and its rule', async () => {
    vi.mocked(queries.readReviewWindow).mockResolvedValue(windowRow(AGENT_REVIEW_EVERY_SCANS * 2));
    expect(await reviewAfterScan('user-1', AGENT, { ai })).toEqual(['s-0']);
    expect(queries.insertSuggestions).toHaveBeenCalledWith('user-1', 'agent-1', [
      expect.objectContaining({
        rule: 'idle_cash',
        dedupeKey: suggestionKey('scan-10', 'idle_cash'),
        change: { setting: 'market_caps', from: ['mega'], to: ['mega', 'large'] },
      }),
    ]);
  });

  it('never throws into the scan, and never reviews the real portfolio', async () => {
    vi.mocked(queries.readReviewWindow).mockRejectedValue(new Error('database down'));
    expect(await reviewAfterScan('user-1', AGENT, { ai })).toEqual([]);
    expect(await reviewAfterScan('user-1', { ...AGENT, is_primary: true }, { ai })).toEqual([]);
    expect(queries.readReviewWindow).toHaveBeenCalledTimes(1);
  });
});
