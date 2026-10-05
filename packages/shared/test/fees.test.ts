/** The fee formula (decision D6). Cases are shared with services/ai/tests/test_fees.py. */

import { describe, expect, it } from 'vitest';

import { BPS_DENOMINATOR, FEE_BPS, MIN_FEE_MINOR, feeMinor, notionalMinor } from '../src/fees.js';

describe('feeMinor', () => {
  it('charges the minimum on a small trade', () => {
    expect(feeMinor(1n)).toBe(MIN_FEE_MINOR);
  });

  it('rounds the proportional fee up', () => {
    const exact = ((MIN_FEE_MINOR + 10n) * BPS_DENOMINATOR) / FEE_BPS;
    expect(feeMinor(exact)).toBe(MIN_FEE_MINOR + 10n);
    expect(feeMinor(exact + 1n)).toBe(MIN_FEE_MINOR + 11n);
  });

  it('meets the minimum where the formula says', () => {
    const crossover = (MIN_FEE_MINOR * BPS_DENOMINATOR) / FEE_BPS;
    expect(feeMinor(crossover)).toBe(MIN_FEE_MINOR);
    expect(feeMinor(crossover + 1n)).toBe(MIN_FEE_MINOR + 1n);
  });

  it('refuses a non-positive notional', () => {
    expect(() => feeMinor(0n)).toThrow(RangeError);
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
