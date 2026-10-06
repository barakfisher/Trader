/**
 * An agent's performance (Stage 3, PR 7; D24, D36-D42), on worked examples
 * whose every figure can be checked by hand.
 *
 * Pinned: the daily value is cash after the last movement before each close
 * plus each holding at that day's close (D36); a deposit buys the shadow SPY at
 * the first close at or after it, fractionally and without fees (D37, D38);
 * both returns are over the same deposits (D24); a missing price makes a day
 * unavailable, never partial (§5.4); the series ends at the last close stored;
 * the score replays only the agent's own fills (D39), counts a sell as a win
 * only after fees (D40), and each sell once, in the windows its date is in (D41).
 */

import { describe, expect, it } from 'vitest';

import type { CashActivityRow, FillRow } from '../src/db/queries.js';
import {
  SCORE_WINDOWS_DAYS,
  agentPerformance,
  benchmarkSessionFor,
  divideRounded,
  scoreAgent,
  type ClosesByInstrument,
  type SessionClose,
} from '../src/services/performance.js';

const AAPL = 'i-AAPL';
const NVDA = 'i-NVDA';
const SPY = 'i-SPY';

/** A New York session closing at 16:00 EDT, 20:00 UTC. */
function session(day: string): SessionClose {
  return { day, closesAt: new Date(`${day}T20:00:00Z`) };
}

function movement(kind: CashActivityRow['kind'], at: string, amount: number, balance: number): CashActivityRow {
  return {
    id: `m-${at}`,
    kind,
    amount_minor: String(amount),
    balance_after_minor: String(balance),
    created_at: new Date(at),
    fill_id: null,
  };
}

function fill(
  instrumentId: string,
  side: 'buy' | 'sell',
  quantity: number,
  priceMinor: number,
  feeMinor: number,
  at: string,
  source: FillRow['source'] = 'manual_user_override',
): FillRow {
  return {
    id: `f-${at}-${instrumentId}`,
    agent_id: 'agent',
    instrument_id: instrumentId,
    symbol: instrumentId.slice(2),
    side,
    quantity: `${quantity}.000000000000000000`,
    price_minor: String(priceMinor),
    notional_minor: String(quantity * priceMinor),
    fee_minor: String(feeMinor),
    currency: 'USD',
    price_source: 'quote',
    quote_as_of: null,
    quote_delay_seconds: null,
    source,
    proposal_id: null,
    idempotency_key: `k-${at}`,
    created_at: new Date(at),
  };
}

function closes(entries: Record<string, Record<string, number>>): ClosesByInstrument {
  return new Map(
    Object.entries(entries).map(([id, byDay]) => [
      id,
      new Map(Object.entries(byDay).map(([day, price]) => [day, BigInt(price)])),
    ]),
  );
}

/**
 * $10,000 deposited Tuesday 2026-10-06 at 10:00 New York; 10 AAPL bought at
 * $200.00 (fee $2.00) at 11:00; $1,000 added Wednesday at 18:00, after the close.
 */
const MOVEMENTS = [
  movement('opening_deposit', '2026-10-06T14:00:00Z', 1_000_000, 1_000_000),
  movement('buy', '2026-10-06T15:00:00Z', -200_200, 799_800),
  movement('top_up', '2026-10-07T22:00:00Z', 100_000, 899_800),
];
const FILLS = [fill(AAPL, 'buy', 10, 20_000, 200, '2026-10-06T15:00:00Z')];
const SESSIONS = ['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'].map(session);
const CLOSES = closes({
  [AAPL]: { '2026-10-06': 20_100, '2026-10-07': 21_000, '2026-10-08': 20_500 },
  [SPY]: { '2026-10-06': 60_000, '2026-10-07': 61_200, '2026-10-08': 60_600 },
});

function perform(overrides: Partial<Parameters<typeof agentPerformance>[0]> = {}) {
  return agentPerformance({
    currency: 'USD',
    movements: MOVEMENTS,
    fills: FILLS,
    sessions: SESSIONS,
    closes: CLOSES,
    benchmarkId: SPY,
    now: new Date('2026-10-09T21:00:00Z'),
    ...overrides,
  });
}

describe('the daily value and the shadow SPY (D24, D36-D38)', () => {
  it('values each close from the ledger, and buys SPY with each deposit at its first close', () => {
    expect(perform().series).toEqual([
      // 799,800 cash + 10 × 201.00; SPY bought at today's close, so worth exactly the deposit.
      { day: '2026-10-06', netWorthMinor: 1_000_800, benchmarkMinor: 1_000_000, depositsMinor: 1_000_000 },
      // 10 × 210.00; SPY 600 → 612 is +2%.
      { day: '2026-10-07', netWorthMinor: 1_009_800, benchmarkMinor: 1_020_000, depositsMinor: 1_000_000 },
      // The top-up came after Wednesday's close, so it is in Thursday's cash and
      // buys SPY at Thursday's close: 1,000,000 × 606/600 + 100,000 × 606/606.
      { day: '2026-10-08', netWorthMinor: 1_104_800, benchmarkMinor: 1_110_000, depositsMinor: 1_100_000 },
    ]);
  });

  it('compares both returns over the same deposits at the latest stored close', () => {
    const { comparison } = perform();
    expect(comparison).toMatchObject({
      day: '2026-10-08',
      depositsMinor: 1_100_000,
      pnlMinor: 4_800,
      benchmarkPnlMinor: 10_000,
    });
    expect(comparison!.returnPct).toBeCloseTo((4_800 / 1_100_000) * 100, 10);
    expect(comparison!.benchmarkReturnPct).toBeCloseTo((10_000 / 1_100_000) * 100, 10);
    expect(comparison!.differencePts).toBeCloseTo(((4_800 - 10_000) / 1_100_000) * 100, 10);
  });

  it("ends at the last close stored, and counts a later deposit as pending, not as a gain", () => {
    // Friday has closed but its close is not stored yet: that day is not
    // recorded, rather than unpriced. A deposit after Thursday's close waits.
    const result = perform({
      movements: [...MOVEMENTS, movement('top_up', '2026-10-09T13:00:00Z', 50_000, 949_800)],
    });
    expect(result.series.at(-1)!.day).toBe('2026-10-08');
    expect(result.pendingDepositsMinor).toBe(50_000);
  });

  it('makes a day with a missing price unavailable, not partial', () => {
    const gap = closes({
      [AAPL]: { '2026-10-06': 20_100, '2026-10-08': 20_500 },
      [SPY]: { '2026-10-06': 60_000, '2026-10-07': 61_200, '2026-10-08': 60_600 },
    });
    const day = perform({ closes: gap }).series.find((point) => point.day === '2026-10-07')!;
    expect(day.netWorthMinor).toBeNull();
    expect(day.benchmarkMinor).toBe(1_020_000);
  });

  it('has no comparison before the first close after the opening deposit', () => {
    // Tuesday 15:00 New York: the deposit and the buy are made, the close is not.
    const result = perform({ movements: MOVEMENTS.slice(0, 2), now: new Date('2026-10-06T19:00:00Z') });
    expect(result.series).toEqual([]);
    expect(result.comparison).toBeNull();
    expect(result.pendingDepositsMinor).toBe(1_000_000);
  });

  it('buys at the first close at or after a deposit: after the close or on a weekend, the next session', () => {
    const week = ['2026-10-09', '2026-10-12'].map(session);
    expect(benchmarkSessionFor(new Date('2026-10-09T19:59:00Z'), week)!.day).toBe('2026-10-09');
    expect(benchmarkSessionFor(new Date('2026-10-09T20:30:00Z'), week)!.day).toBe('2026-10-12');
    expect(benchmarkSessionFor(new Date('2026-10-10T15:00:00Z'), week)!.day).toBe('2026-10-12');
  });
});

describe("the score of the agent's own decisions (D39-D41)", () => {
  const NOW = new Date('2026-12-01T12:00:00Z');

  it('is empty until the agent decides: manual trades are never scored', () => {
    const score = scoreAgent(FILLS, CLOSES, NOW);
    expect(score.agentDecisions).toBe(0);
    expect(score.windows.map((window) => window.days)).toEqual([...SCORE_WINDOWS_DAYS]);
    expect(score.windows.every((window) => window.sells === 0 && window.winRatePct === null)).toBe(true);
    expect(score.unrealisedPnlMinor).toBe(0);
  });

  it('counts a sell as a win only after fees (D40)', () => {
    // Bought 10 at $100.00 (fee $1.50), sold 10 at $100.10 (fee $1.50): the
    // price rose, the trade lost $2.00.
    const fills = [
      fill(AAPL, 'buy', 10, 10_000, 150, '2026-11-20T15:00:00Z', 'agent'),
      fill(AAPL, 'sell', 10, 10_010, 150, '2026-11-21T15:00:00Z', 'agent'),
    ];
    const [thirty] = scoreAgent(fills, CLOSES, NOW).windows;
    expect(thirty).toMatchObject({ decisions: 2, sells: 1, wins: 0, winRatePct: 0, realisedPnlMinor: -200 });
  });

  it("scores the agent's own book, as if the user had not intervened (D39)", () => {
    // The agent buys 10 NVDA at $100; the user sells 4 by hand at $90; the agent
    // sells the 6 still held at $120. Scored: 6 of the agent's 10, at their
    // share of its cost (100,150 × 6/10 = 60,090), against 72,000 − 150.
    const fills = [
      fill(NVDA, 'buy', 10, 10_000, 150, '2026-11-10T15:00:00Z', 'agent'),
      fill(NVDA, 'sell', 4, 9_000, 150, '2026-11-11T15:00:00Z'),
      fill(NVDA, 'sell', 6, 12_000, 150, '2026-11-12T15:00:00Z', 'agent'),
    ];
    const score = scoreAgent(fills, CLOSES, NOW);
    expect(score.agentDecisions).toBe(2);
    expect(score.windows[0]).toMatchObject({ sells: 1, wins: 1, winRatePct: 100, realisedPnlMinor: 71_850 - 60_090 });
    // The book still claims 4 shares, but none is held: nothing is unrealised.
    expect(score.unrealisedPnlMinor).toBe(0);
  });

  it('leaves out a sell of shares only the user bought', () => {
    const fills = [
      fill(NVDA, 'buy', 5, 10_000, 150, '2026-11-10T15:00:00Z'),
      fill(NVDA, 'sell', 5, 12_000, 150, '2026-11-12T15:00:00Z', 'agent'),
    ];
    expect(scoreAgent(fills, CLOSES, NOW).windows[0]).toMatchObject({ decisions: 1, sells: 0, winRatePct: null });
  });

  it('counts each sell once, in the windows its date falls in (D41)', () => {
    const fills = [
      fill(NVDA, 'buy', 10, 10_000, 150, '2026-08-01T15:00:00Z', 'agent'),
      fill(NVDA, 'sell', 5, 11_000, 150, '2026-10-17T15:00:00Z', 'agent'), // 45 days before NOW
      fill(NVDA, 'sell', 5, 9_000, 150, '2026-11-21T15:00:00Z', 'agent'), // 10 days before NOW
    ];
    const [thirty, sixty, ninety] = scoreAgent(fills, CLOSES, NOW).windows;
    expect(thirty).toMatchObject({ sells: 1, wins: 0, decisions: 1 });
    expect(sixty).toMatchObject({ sells: 2, wins: 1, winRatePct: 50, decisions: 2 });
    // The buy is 122 days old: in no window, though its sells are scored against it.
    expect(ninety).toMatchObject({ sells: 2, decisions: 2 });
  });

  it('values what the book still holds at the latest close, and is null when that is unpriced', () => {
    const fills = [fill(AAPL, 'buy', 10, 20_000, 200, '2026-10-06T15:00:00Z', 'agent')];
    // 10 × 205.00 − (200,000 + 200).
    expect(scoreAgent(fills, CLOSES, NOW).unrealisedPnlMinor).toBe(205_000 - 200_200);
    expect(scoreAgent(fills, closes({}), NOW).unrealisedPnlMinor).toBeNull();
  });
});

describe('divideRounded', () => {
  it('rounds half up, once, and keeps the sign', () => {
    expect(divideRounded(5n, 2n)).toBe(3n);
    expect(divideRounded(4n, 3n)).toBe(1n);
    expect(divideRounded(-5n, 2n)).toBe(-3n);
  });
});
