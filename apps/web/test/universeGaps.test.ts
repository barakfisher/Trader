import { describe, expect, it } from 'vitest';

import type { UniverseGap } from '@traders/shared';

import { gapExplanation, gapProfile, gapSubject, isRealGap } from '../src/lib/universeGaps.ts';

function gap(
  kind: UniverseGap['kind'],
  detail: Record<string, unknown>,
  profile: UniverseGap['profile'] = null,
): UniverseGap {
  return {
    profile,
    id: '1',
    kind,
    userId: 'u',
    detail,
    occurrences: 1,
    firstSeenAt: '2026-10-01T06:00:00Z',
    lastSeenAt: '2026-10-01T06:00:00Z',
  };
}

describe('a universe gap, in words', () => {
  it('says which screen rule keeps a listing out, and does not call it a real gap', () => {
    const sap = gap('universe_gap_missing_ticker', {
      symbol: 'SAP.DE',
      source: 'holding',
      gap: 'outside_screen',
      rule: 'exchange',
    });
    expect(gapSubject(sap)).toBe('SAP.DE');
    expect(gapExplanation(sap)).toBe(
      'added as a holding; not listed on a primary US exchange, so never screened',
    );
    expect(isRealGap(sap)).toBe(false);
  });

  it('marks a US listing the universe lacks as the gap a rescreen could close', () => {
    const tiny = gap('universe_gap_missing_ticker', { symbol: 'TINY', source: 'topic', gap: 'not_in_universe' });
    expect(gapExplanation(tiny)).toMatch(/^added to a topic; a US listing the universe lacks/);
    expect(isRealGap(tiny)).toBe(true);
  });

  it('gives a topic its best score beside the gate', () => {
    const topic = gap('universe_gap_low_confidence', {
      topic: 'quantum computing',
      bestSimilarity: 0.1834,
      refuseBelow: 0.23,
    });
    expect(gapSubject(topic)).toBe('“quantum computing”');
    expect(gapExplanation(topic)).toBe('topic matched nothing: best score 0.18, gate 0.23');
    expect(isRealGap(topic)).toBe(true);
  });

  it('says a symbol nothing could price was unpriced', () => {
    expect(
      gapExplanation(gap('universe_gap_missing_ticker', { symbol: 'X', source: 'import', gap: 'unpriced' })),
    ).toBe('in an import; no market data provider could price it');
  });

  it('says what became of a missing listing, and a closed gap is no longer real', () => {
    const detail = { symbol: 'BYND', source: 'holding', gap: 'not_in_universe', rule: null };
    const described = gap('universe_gap_missing_ticker', detail, 'on_demand');
    expect(gapProfile(described)).toMatch(/^profiled on demand; no topic is answered from it/);
    expect(isRealGap(described)).toBe(true);

    const admitted = gap('universe_gap_missing_ticker', detail, 'screened');
    expect(gapProfile(admitted)).toBe('now in the universe');
    expect(isRealGap(admitted)).toBe(false);

    expect(gapProfile(gap('universe_gap_missing_ticker', detail))).toBeNull();
  });
});
