import { describe, expect, it } from 'vitest';

import { combineSummaries, type PortfolioSummary } from '../src/index.js';

const base: PortfolioSummary = {
  baseCurrency: 'USD',
  totalValueMinor: 0,
  totalCostMinor: 0,
  pnlMinor: null,
  pnlPct: null,
  dayChangeMinor: null,
  dayChangePct: null,
  holdingsCount: 0,
  pricedCount: 0,
  unpricedSymbols: [],
  uncostedSymbols: [],
  degraded: false,
  asOf: '2026-10-21T00:00:00Z',
};

describe('combineSummaries (D231)', () => {
  it('adds money exactly and computes each percentage again from the sums', () => {
    const real = { ...base, totalValueMinor: 110_00, totalCostMinor: 100_00, pnlMinor: 10_00, dayChangeMinor: 10_00, holdingsCount: 1, pricedCount: 1 };
    const paper = { ...base, totalValueMinor: 90_00, totalCostMinor: 100_00, pnlMinor: -10_00, dayChangeMinor: -10_00, holdingsCount: 2, pricedCount: 2 };
    const combined = combineSummaries('USD', [real, paper], base.asOf);
    expect(combined.totalValueMinor).toBe(200_00);
    expect(combined.totalCostMinor).toBe(200_00);
    expect(combined.pnlMinor).toBe(0);
    expect(combined.pnlPct).toBe(0);
    expect(combined.dayChangeMinor).toBe(0);
    expect(combined.dayChangePct).toBe(0);
    expect(combined.holdingsCount).toBe(3);
  });

  it('keeps a missing P&L or day change missing, never zero', () => {
    const combined = combineSummaries('USD', [base, base], base.asOf);
    expect(combined.pnlMinor).toBeNull();
    expect(combined.dayChangeMinor).toBeNull();
  });

  it('names every unpriced and uncosted symbol once, and is degraded if any part is', () => {
    const combined = combineSummaries(
      'USD',
      [
        { ...base, unpricedSymbols: ['B'], uncostedSymbols: ['X'], degraded: true },
        { ...base, unpricedSymbols: ['A', 'B'], uncostedSymbols: ['X'] },
      ],
      base.asOf,
    );
    expect(combined.unpricedSymbols).toEqual(['A', 'B']);
    expect(combined.uncostedSymbols).toEqual(['X']);
    expect(combined.degraded).toBe(true);
  });
});
