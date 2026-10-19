/**
 * The mandate's form logic (D165-D174): percent to basis points and back, the
 * presets, the generated instructions and where an agent stands over a limit.
 */

import { describe, expect, it } from 'vitest';

import {
  EMPTY_MANDATE_DRAFT,
  RISK_PRESETS,
  applyRisk,
  bpsToPercent,
  describeMandate,
  draftFromMandate,
  editRule,
  mandateInput,
  mandateProblems,
  overLimits,
  percentToBps,
  riskBand,
  withMandate,
} from '../src/lib/agentMandate.ts';

describe('percentages', () => {
  it('reads a typed percentage as integer basis points, and writes it back the same', () => {
    expect([percentToBps('10'), percentToBps('12.5'), percentToBps('0.05'), percentToBps('')]).toEqual([1000, 1250, 5, null]);
    expect([percentToBps('12.555'), percentToBps('-1'), percentToBps('ten')]).toEqual([undefined, undefined, undefined]);
    for (const bps of [1, 5, 50, 1000, 1250, 1205, 9999, 10000]) expect(percentToBps(bpsToPercent(bps))).toBe(bps);
  });

  it('names the fields that cannot be sent as typed', () => {
    expect(mandateProblems(EMPTY_MANDATE_DRAFT)).toEqual([]);
    const bad = { ...EMPTY_MANDATE_DRAFT, maxPositionPct: '0', cashBufferPct: '100', maxHoldings: '0', blockedSymbols: 'a b!' };
    expect(mandateProblems(bad)).toEqual(['maxPositionPct', 'cashBufferPct', 'maxHoldings', 'blockedSymbols']);
  });
});

describe('the risk slider (D169)', () => {
  it('reads ten levels as five bands of two, as the scan does', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(riskBand)).toEqual([
      'ultraConservative', 'ultraConservative', 'conservative', 'conservative', 'balanced',
      'balanced', 'growth', 'growth', 'aggressive', 'aggressive',
    ]);
  });

  it('proposes every limit, bolder with each level, except one typed by hand', () => {
    for (let level = 2; level <= 10; level += 1) {
      expect(Number(RISK_PRESETS[level]!.maxPositionPct)).toBeGreaterThanOrEqual(Number(RISK_PRESETS[level - 1]!.maxPositionPct));
      expect(Number(RISK_PRESETS[level]!.cashBufferPct)).toBeLessThanOrEqual(Number(RISK_PRESETS[level - 1]!.cashBufferPct));
    }
    const typed = editRule(EMPTY_MANDATE_DRAFT, 'cashBufferPct', '33');
    const moved = applyRisk(typed, 10);
    expect(moved).toMatchObject({ riskLevel: 10, maxPositionPct: '30', cashBufferPct: '33', maxHoldings: '5' });
  });
});

describe('the instructions written from the settings (D174)', () => {
  it('says nothing when nothing is set, and never a figure', () => {
    expect(describeMandate(EMPTY_MANDATE_DRAFT)).toBe('');
    const text = describeMandate({ ...applyRisk(EMPTY_MANDATE_DRAFT, 9), sectors: ['Energy'], allowEtfs: false });
    expect(text).toContain('You focus on Energy.');
    expect(text).toContain('not ETFs');
    expect(text).not.toMatch(/\d/);
  });

  it('rewrites untouched instructions and keeps edited ones', () => {
    const start = { persona: '', generated: '', mandate: EMPTY_MANDATE_DRAFT };
    const written = withMandate(start, { ...EMPTY_MANDATE_DRAFT, horizon: 'short' });
    expect(written.persona).toBe(written.generated);
    expect(written.persona).not.toBe('');
    const rewritten = withMandate(written, { ...written.mandate, horizon: 'long' });
    expect(rewritten.persona).toContain('months to years');
    const edited = withMandate({ ...rewritten, persona: 'My own words.' }, { ...rewritten.mandate, horizon: 'medium' });
    expect(edited.persona).toBe('My own words.');
    expect(edited.generated).toContain('weeks to a few months');
  });
});

describe('a stored mandate', () => {
  const stored = {
    riskLevel: 4,
    horizon: 'long' as const,
    thesisStyle: null,
    maxPositionBps: 1250,
    cashBufferBps: null,
    maxHoldings: 8,
    allowEtfs: true,
    marketCaps: [],
    sectors: [],
    industries: [],
    etfCategories: [],
    blockedSymbols: ['XOM'],
  };

  it('round-trips through the draft, its stored limits counting as typed', () => {
    const draft = draftFromMandate(stored);
    expect(draft.edited).toEqual(['maxPositionPct', 'maxHoldings']);
    expect(mandateInput(draft)).toEqual(stored);
    expect(mandateInput(draftFromMandate(null))).toEqual(mandateInput(EMPTY_MANDATE_DRAFT));
  });

  it('reports a position, the cash and the count over their limits, and judges no holding of unknown cost', () => {
    const account = {
      cashMinor: 10_000,
      holdings: [
        { instrument: { symbol: 'BIG' }, costMinor: 30_000 },
        { instrument: { symbol: 'UNKNOWN' }, costMinor: null },
      ],
    };
    const tight = { ...stored, maxPositionBps: 5000, cashBufferBps: 5000, maxHoldings: 1 };
    expect(overLimits(tight, account)).toEqual([{ kind: 'position', symbol: 'BIG' }, { kind: 'cash' }, { kind: 'holdings' }]);
    // Exactly at the limit is inside it: 20,000 of capital 40,000 is 50%.
    expect(overLimits({ ...tight, cashBufferBps: null, maxHoldings: null }, { ...account, holdings: [{ instrument: { symbol: 'HALF' }, costMinor: 20_000 }], cashMinor: 20_000 })).toEqual([]);
    expect(overLimits(null, account)).toEqual([]);
  });
});
