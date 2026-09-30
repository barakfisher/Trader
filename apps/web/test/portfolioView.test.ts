import { expect, it } from 'vitest';

import { shortRate } from '../src/lib/portfolioView.ts';

it('cuts an FX rate to four places on its digits', () => {
  expect(shortRate('1.135589361190796')).toBe('1.1355');
  expect(shortRate('1.1')).toBe('1.1');
  expect(shortRate('1')).toBe('1');
});
