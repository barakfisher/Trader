import { expect, it } from 'vitest';

import { symbolChoices } from '../src/components/ObservationsFeed.tsx';
import { feedFiltersFrom } from '../src/lib/feedFilters.ts';

it('reads the filters an address carries, and drops what it does not recognise', () => {
  expect(feedFiltersFrom({ severity: 'high', symbol: 'nvda' })).toEqual({
    severity: 'high',
    symbol: 'NVDA',
  });
  expect(feedFiltersFrom({ severity: 'urgent', symbol: '<script>' })).toEqual({});
  expect(feedFiltersFrom({ severity: 'info' })).toEqual({});
  expect(feedFiltersFrom(undefined)).toEqual({});
  expect(feedFiltersFrom({ symbol: 'BTC-USD' })).toEqual({ symbol: 'BTC-USD' });
});

it('offers the held symbols, and keeps a filtered one that is no longer held', () => {
  expect(symbolChoices(['VOO', 'AAPL'], undefined)).toEqual(['AAPL', 'VOO']);
  expect(symbolChoices(['VOO'], 'SPY')).toEqual(['SPY', 'VOO']);
  expect(symbolChoices(undefined, undefined)).toEqual([]);
});
