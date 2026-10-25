import { describe, expect, it } from 'vitest';

import {
  SORT_KEYS,
  compareDecimal,
  firstDirection,
  holdingsSortFrom,
  holdingsSortSearch,
  nextSort,
  sentimentRank,
  sortHoldings,
  type SortFields,
} from '../src/lib/holdingsSort.ts';

function row(symbol: string, overrides: Partial<SortFields> = {}): SortFields {
  return {
    symbol,
    quantity: '1',
    price: { minor: 100, currency: 'USD' },
    day: 0,
    value: 100,
    cost: 100,
    pnl: 0,
    pnlPct: 0,
    weight: 10,
    sentiment: null,
    ...overrides,
  };
}

const symbols = (rows: SortFields[]) => rows.map((r) => r.symbol);

describe('the order in the address', () => {
  it('reads a known column and direction, and ignores anything else', () => {
    expect(holdingsSortFrom({ sort: 'pnlPct', dir: 'asc' })).toEqual({ key: 'pnlPct', direction: 'asc' });
    expect(holdingsSortFrom({ sort: 'value' })).toEqual({ key: 'value', direction: 'desc' });
    expect(holdingsSortFrom({ sort: 'nonsense', dir: 'asc' })).toBeNull();
    expect(holdingsSortFrom(undefined)).toBeNull();
  });

  it('writes nothing for the server order, so the plain address means it', () => {
    expect(holdingsSortSearch(null)).toEqual({ sort: undefined, dir: undefined });
    expect(holdingsSortSearch({ key: 'weight', direction: 'asc' })).toEqual({ sort: 'weight', dir: 'asc' });
  });

  it('round-trips every column', () => {
    for (const key of SORT_KEYS) {
      for (const direction of ['asc', 'desc'] as const) {
        expect(holdingsSortFrom(holdingsSortSearch({ key, direction }))).toEqual({ key, direction });
      }
    }
  });
});

describe('a header click', () => {
  it('starts names A to Z and figures largest first, and flips on a second click', () => {
    expect(firstDirection('symbol')).toBe('asc');
    expect(firstDirection('value')).toBe('desc');
    expect(nextSort(null, 'value')).toEqual({ key: 'value', direction: firstDirection('value') });
    expect(nextSort({ key: 'value', direction: 'desc' }, 'value')).toEqual({ key: 'value', direction: 'asc' });
    expect(nextSort({ key: 'value', direction: 'asc' }, 'symbol')).toEqual({ key: 'symbol', direction: 'asc' });
  });
});

describe('sortHoldings', () => {
  const rows = [row('B', { value: 300 }), row('A', { value: null }), row('C', { value: 100 }), row('D', { value: 300 })];

  it('keeps the server order with no sort, and never touches its input', () => {
    const copy = [...rows];
    expect(symbols(sortHoldings(rows, (r) => r, null))).toEqual(['B', 'A', 'C', 'D']);
    sortHoldings(rows, (r) => r, { key: 'value', direction: 'asc' });
    expect(rows).toEqual(copy);
  });

  it('puts a row with no figure last in both directions, ties by symbol', () => {
    expect(symbols(sortHoldings(rows, (r) => r, { key: 'value', direction: 'desc' }))).toEqual(['B', 'D', 'C', 'A']);
    expect(symbols(sortHoldings(rows, (r) => r, { key: 'value', direction: 'asc' }))).toEqual(['C', 'B', 'D', 'A']);
  });

  it('compares quantities as decimals, not as text or floats', () => {
    const quantities = [row('A', { quantity: '10' }), row('B', { quantity: '9.5' }), row('C', { quantity: '0.000000000000000001' })];
    expect(symbols(sortHoldings(quantities, (r) => r, { key: 'quantity', direction: 'asc' }))).toEqual(['C', 'B', 'A']);
  });

  it('orders prices by currency first: two currencies are not one scale', () => {
    const prices = [
      row('A', { price: { minor: 50, currency: 'USD' } }),
      row('B', { price: { minor: 900, currency: 'ILS' } }),
      row('C', { price: null }),
      row('D', { price: { minor: 10, currency: 'USD' } }),
    ];
    expect(symbols(sortHoldings(prices, (r) => r, { key: 'price', direction: 'asc' }))).toEqual(['B', 'D', 'A', 'C']);
  });

  it('sorts losses below gains on P&L', () => {
    const pnl = [row('A', { pnlPct: 4.2 }), row('B', { pnlPct: -12.5 }), row('C', { pnlPct: null }), row('D', { pnlPct: 0 })];
    expect(symbols(sortHoldings(pnl, (r) => r, { key: 'pnlPct', direction: 'desc' }))).toEqual(['A', 'D', 'B', 'C']);
  });

  it('orders Sentiment Bullish, Neutral, Bearish, with an unrated holding last both ways', () => {
    const rated = [
      row('A', { sentiment: sentimentRank('bearish') }),
      row('B', { sentiment: sentimentRank(undefined) }),
      row('C', { sentiment: sentimentRank('bullish') }),
      row('D', { sentiment: sentimentRank('neutral') }),
      row('E', { sentiment: sentimentRank('bullish') }),
    ];
    expect(firstDirection('sentiment')).toBe('desc');
    expect(symbols(sortHoldings(rated, (r) => r, { key: 'sentiment', direction: 'desc' }))).toEqual(['C', 'E', 'D', 'A', 'B']);
    expect(symbols(sortHoldings(rated, (r) => r, { key: 'sentiment', direction: 'asc' }))).toEqual(['A', 'D', 'C', 'E', 'B']);
  });
});

describe('compareDecimal', () => {
  it.each([
    ['1', '1.0', 0],
    ['0.1', '0.10000', 0],
    ['2', '10', -1],
    ['-3', '2', -1],
    ['-3', '-2', -1],
    ['-0', '0', 0],
    ['123456789012345678.000000000000000001', '123456789012345678', 1],
  ])('%s vs %s is %i', (a, b, expected) => {
    expect(compareDecimal(a, b)).toBe(expected);
  });
});
