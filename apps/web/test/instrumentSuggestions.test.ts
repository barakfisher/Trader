/** Which local listings the add-holding form offers for what was typed (D324). */

import { describe, expect, it } from 'vitest';

import type { InstrumentSuggestion } from '@traders/shared';

import { matchDirectory, NAME_MATCH_MIN_LENGTH, SUGGESTION_LIMIT } from '../src/lib/instrumentSuggestions.ts';

const listing = (symbol: string, name: string | null = null): InstrumentSuggestion => ({
  symbol,
  name,
  assetClass: 'equity',
  exchange: null,
});

const DIRECTORY = [
  listing('SPYG', 'SPDR Portfolio S&P 500 Growth ETF'),
  listing('SPY', 'SPDR S&P 500 ETF Trust'),
  listing('AAPL', 'Apple Inc.'),
  listing('F', 'Ford Motor Company'),
  listing('FSLR', 'First Solar'),
];

describe('matching the local directory', () => {
  it('puts an exact symbol first, then shorter prefixes', () => {
    expect(matchDirectory(DIRECTORY, 'f').map((entry) => entry.symbol)).toEqual(['F', 'FSLR']);
    expect(matchDirectory(DIRECTORY, 'sp').map((entry) => entry.symbol)).toEqual(['SPY', 'SPYG']);
  });

  it('matches a name only from NAME_MATCH_MIN_LENGTH characters, after the symbols', () => {
    const short = 'a'.repeat(NAME_MATCH_MIN_LENGTH - 1);
    expect(matchDirectory(DIRECTORY, short).map((entry) => entry.symbol)).toEqual(['AAPL']);
    expect(matchDirectory(DIRECTORY, 'apple').map((entry) => entry.symbol)).toEqual(['AAPL']);
    expect(matchDirectory(DIRECTORY, 'solar').map((entry) => entry.symbol)).toEqual(['FSLR']);
  });

  it('offers nothing for blank typing and never more than the limit', () => {
    expect(matchDirectory(DIRECTORY, '   ')).toEqual([]);
    const many = Array.from({ length: SUGGESTION_LIMIT + 5 }, (_, index) => listing(`X${index}`));
    expect(matchDirectory(many, 'x')).toHaveLength(SUGGESTION_LIMIT);
  });
});
