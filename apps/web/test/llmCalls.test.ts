/**
 * Model-call wording and arithmetic for the admin page: cost in integer
 * micro-USD rounded once, and a zero that means "free route" only where it is.
 */

import { describe, expect, it } from 'vitest';

import { agentCost, callCost, formatLatency, formatMicroUsd, nonZero, reasonLabel } from '../src/lib/llmCalls.ts';

describe('cost', () => {
  it('shows fractions of a cent to four places, rounding once', () => {
    expect(formatMicroUsd(0)).toBe('$0');
    expect(formatMicroUsd(49)).toBe('<$0.0001');
    expect(formatMicroUsd(1250)).toBe('$0.0013');
    expect(formatMicroUsd(10_000)).toBe('$0.01');
    expect(formatMicroUsd(3_000_000_000)).toBe('$3,000.00');
  });

  it('says free route only when every model reached was free', () => {
    const free = { model: 'm:free', calls: 1, free: true };
    expect(agentCost({ costMicroUsd: 0, models: [free] })).toBe('free route');
    expect(agentCost({ costMicroUsd: 0, models: [free, { model: 'paid', calls: 1, free: false }] })).toBe(
      '$0',
    );
    // Refused before any model was chosen: nothing was free, nothing was billed.
    expect(agentCost({ costMicroUsd: 0, models: [{ model: null, calls: 1, free: false }] })).toBe('$0');
  });
});

describe('one call', () => {
  it('says free for a free route, and prices anything else', () => {
    expect(callCost({ costMicroUsd: 0, model: 'm:free' })).toBe('free');
    expect(callCost({ costMicroUsd: 0, model: null })).toBe('$0');
    expect(callCost({ costMicroUsd: 1250, model: 'paid' })).toBe('$0.0013');
  });
});

describe('wording', () => {
  it('names reasons, and keeps an unknown one as it is', () => {
    expect(reasonLabel('none')).toBe('written by the model');
    expect(reasonLabel('something_new')).toBe('something_new');
  });

  it('lists only non-zero counts, largest first', () => {
    expect(nonZero({ a: 1, b: 0, c: 3 }, { a: 'A', b: 'B', c: 'C' })).toEqual([
      { key: 'c', label: 'C', count: 3 },
      { key: 'a', label: 'A', count: 1 },
    ]);
  });

  it('shows latency in ms below a second', () => {
    expect(formatLatency(999)).toBe('999 ms');
    expect(formatLatency(14_292)).toBe('14.3 s');
  });
});
