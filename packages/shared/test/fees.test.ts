/** The fee formula (decisions D6, D76). Cases are shared with services/ai/tests/test_fees.py. */

import { describe, expect, it } from 'vitest';

import { FEE_PER_SHARE_MINOR, MIN_FEE_MINOR, feeMinor, notionalMinor } from '../src/fees.js';

/** The share count at which the per-share fee reaches the minimum. */
const CROSSOVER = MIN_FEE_MINOR / FEE_PER_SHARE_MINOR;

describe('feeMinor', () => {
  it('charges the minimum on a small trade', () => {
    expect(feeMinor('1')).toBe(MIN_FEE_MINOR);
  });

  it('meets the minimum where the formula says', () => {
    expect(feeMinor(CROSSOVER.toString())).toBe(MIN_FEE_MINOR);
    expect(feeMinor((CROSSOVER + 1n).toString())).toBe(MIN_FEE_MINOR + FEE_PER_SHARE_MINOR);
  });

  it('charges per share above the minimum', () => {
    const shares = 4n * CROSSOVER;
    expect(feeMinor(shares.toString())).toBe(shares * FEE_PER_SHARE_MINOR);
    expect(feeMinor(`${shares}.000`)).toBe(shares * FEE_PER_SHARE_MINOR);
  });

  it.each(['0', '-1', '1.5', '', 'abc'])('refuses %j', (quantity) => {
    expect(() => feeMinor(quantity)).toThrow(RangeError);
  });
});

describe('notionalMinor', () => {
  it('multiplies whole shares by the price', () => {
    expect(notionalMinor('3', 12_345n)).toBe(37_035n);
    expect(notionalMinor('3.000', 12_345n)).toBe(37_035n);
  });

  it.each(['0', '-1', '1.5', '', 'abc'])('refuses %j', (quantity) => {
    expect(() => notionalMinor(quantity, 100n)).toThrow(RangeError);
  });
});
