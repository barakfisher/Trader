/**
 * The mandate's size rules at approval (D299): the same comparisons as the scan's
 * `mandate.size_problems`, exact in integers, over capital at cost (D171).
 */

import { describe, expect, it } from 'vitest';

import { MAX_HOLDINGS_LIMIT } from '../src/http/agentMandate.js';
import { mandateBreaches, type MandateBook, type MandateLimits } from '../src/services/mandateLimits.js';

const NO_LIMITS: MandateLimits = { max_position_bps: null, cash_buffer_bps: null, max_holdings: null };

/** $10,000.00 of capital: $6,000.00 cash and $4,000.00 held at cost, $1,000.00 of it in the symbol. */
const BOOK: MandateBook = {
  cashMinor: 600_000n,
  holdingsCostMinor: 400_000n,
  symbolCostMinor: 100_000n,
  heldCount: 3,
  holdsSymbol: true,
};

const buy = (notionalMinor: bigint, feeMinor = 0n) => ({ side: 'buy' as const, notionalMinor, feeMinor });

describe('the position limit', () => {
  const limits = { ...NO_LIMITS, max_position_bps: 2_000 };

  it('allows a position exactly at the limit and warns a cent past it', () => {
    // 20% of $10,000.00 is $2,000.00; $1,000.00 is held already.
    expect(mandateBreaches(limits, BOOK, buy(100_000n))).toEqual([]);
    expect(mandateBreaches(limits, BOOK, buy(100_001n))).toEqual([
      {
        rule: 'max_position',
        limitBps: 2_000,
        capitalMinor: 1_000_000,
        positionAfterMinor: 200_001,
        positionAfterBps: 2_001,
        overByMinor: 1,
        suggestedBps: 2_100,
      },
    ]);
  });

  it('rounds how far over up to the cent, so a breach never reads as zero', () => {
    // Capital $333.33: 10% is $33.333, so $33.34 is past it by a fraction of a cent.
    const small: MandateBook = { cashMinor: 33_333n, holdingsCostMinor: 0n, symbolCostMinor: 0n, heldCount: 0, holdsSymbol: false };
    const [breach] = mandateBreaches({ ...NO_LIMITS, max_position_bps: 1_000 }, small, buy(3_334n));
    expect(breach).toMatchObject({ rule: 'max_position', overByMinor: 1, suggestedBps: 1_100 });
  });

  it('suggests a whole percent at or above what the trade needs', () => {
    // $1,000.00 + $1,550.00 = 25.5% of capital: 26% allows it, 25% would not.
    const [breach] = mandateBreaches(limits, BOOK, buy(155_000n));
    expect(breach).toMatchObject({ positionAfterBps: 2_550, suggestedBps: 2_600 });
  });
});

describe('the cash buffer', () => {
  const limits = { ...NO_LIMITS, cash_buffer_bps: 3_000 };

  it('counts the fee, and allows cash exactly at the minimum', () => {
    // 30% of $10,000.00 is $3,000.00: $6,000.00 less $2,990.00 and a $10.00 fee leaves it.
    expect(mandateBreaches(limits, BOOK, buy(299_000n, 1_000n))).toEqual([]);
    expect(mandateBreaches(limits, BOOK, buy(299_000n, 1_001n))).toEqual([
      {
        rule: 'cash_buffer',
        limitBps: 3_000,
        capitalMinor: 1_000_000,
        cashAfterMinor: 299_999,
        cashAfterBps: 2_999,
        shortByMinor: 1,
        suggestedBps: 2_900,
      },
    ]);
  });

  it('suggests no buffer at all when the buy spends every cent', () => {
    const [breach] = mandateBreaches(limits, BOOK, buy(599_000n, 1_000n));
    expect(breach).toMatchObject({ cashAfterMinor: 0, cashAfterBps: 0, suggestedBps: 0 });
  });
});

describe('the holdings limit', () => {
  it('warns only for an instrument the agent does not hold yet', () => {
    const limits = { ...NO_LIMITS, max_holdings: 3 };
    expect(mandateBreaches(limits, BOOK, buy(1n))).toEqual([]);
    expect(mandateBreaches(limits, { ...BOOK, holdsSymbol: false }, buy(1n))).toEqual([
      { rule: 'max_holdings', limit: 3, heldCount: 3, suggestedLimit: 4 },
    ]);
  });

  it('suggests nothing past the most the settings allow', () => {
    const full = { ...BOOK, heldCount: MAX_HOLDINGS_LIMIT, holdsSymbol: false };
    expect(mandateBreaches({ ...NO_LIMITS, max_holdings: MAX_HOLDINGS_LIMIT }, full, buy(1n))).toEqual([
      { rule: 'max_holdings', limit: MAX_HOLDINGS_LIMIT, heldCount: MAX_HOLDINGS_LIMIT, suggestedLimit: null },
    ]);
  });
});

describe('what is never checked (D165)', () => {
  it('a sell, whatever it does to the limits, and an agent with no limits', () => {
    const strict = { max_position_bps: 1, cash_buffer_bps: 9_999, max_holdings: 1 };
    expect(mandateBreaches(strict, BOOK, { side: 'sell', notionalMinor: 500_000n, feeMinor: 0n })).toEqual([]);
    expect(mandateBreaches(NO_LIMITS, BOOK, buy(599_000n, 1_000n))).toEqual([]);
  });
});
