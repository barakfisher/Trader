/**
 * Money at the currency's exponent, in both directions.
 *
 * An edit field starts from the stored minor units and saves what the person
 * typed, so the two conversions must agree exactly: opening and saving an
 * untouched cost must not move it by a cent (or by a factor of a hundred, in a
 * zero-decimal currency).
 */

import { describe, expect, it } from 'vitest';

import { minorToDecimalString, minorUnitExponent, parseToMinor } from '../src/money.js';

describe('minorToDecimalString', () => {
  it('writes the decimal a person would type, at the currency exponent', () => {
    expect(minorToDecimalString(12345, 'USD')).toBe('123.45');
    expect(minorToDecimalString(5, 'USD')).toBe('0.05');
    expect(minorToDecimalString(0, 'EUR')).toBe('0.00');
    expect(minorToDecimalString(1500, 'JPY')).toBe('1500');
    expect(minorToDecimalString(-250, 'USD')).toBe('-2.50');
  });

  it.each([
    [12345, 'USD'],
    [1, 'USD'],
    [9_007_199_254_740_991, 'USD'],
    [1500, 'JPY'],
    [7, 'KRW'],
    [-999, 'GBP'],
  ])('reads back through parseToMinor unchanged: %i %s', (minor, currency) => {
    expect(parseToMinor(minorToDecimalString(minor, currency), currency)).toBe(minor);
  });
});

describe('parseToMinor', () => {
  it('parses at the currency exponent, not at two places for everything', () => {
    expect(minorUnitExponent('JPY')).toBe(0);
    expect(parseToMinor('1500', 'JPY')).toBe(1500);
    expect(parseToMinor('1500', 'USD')).toBe(150000);
  });

  it('rounds half up once, and refuses what is not a number', () => {
    expect(parseToMinor('1.005', 'USD')).toBe(101);
    expect(parseToMinor('1.004', 'USD')).toBe(100);
    expect(parseToMinor('abc', 'USD')).toBeNull();
  });
});
