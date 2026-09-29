/** The equity curve's series: measured days only, gaps as gaps, understatements marked. */

import { describe, expect, it } from 'vitest';

import type { PortfolioSnapshot } from '@traders/shared';

import { coverageText, curvePoints } from '../src/lib/equityCurve.ts';

function snapshot(asOf: string, over: Partial<PortfolioSnapshot> = {}): PortfolioSnapshot {
  return {
    asOf,
    totalMinor: 10_000_00,
    costMinor: 8_000_00,
    currency: 'USD',
    holdingsCount: 10,
    pricedCount: 10,
    degraded: false,
    ...over,
  };
}

describe('curvePoints', () => {
  it('gives every calendar day a point, and a day with no snapshot no value', () => {
    const points = curvePoints([snapshot('2026-09-27'), snapshot('2026-09-29')]);
    expect(points.map((p) => p.date)).toEqual(['2026-09-27', '2026-09-28', '2026-09-29']);
    // A gap, never an interpolation between the two measured days.
    expect(points[1]).toMatchObject({ totalMinor: null, costMinor: null });
  });

  it('keeps the stored figures exactly, in minor units', () => {
    const [point] = curvePoints([snapshot('2026-09-29', { totalMinor: 9_986_207 })]);
    expect(point!.totalMinor).toBe(9_986_207);
  });

  it('orders by date whatever order the snapshots arrive in', () => {
    const points = curvePoints([snapshot('2026-09-29'), snapshot('2026-09-28')]);
    expect(points.map((p) => p.date)).toEqual(['2026-09-28', '2026-09-29']);
  });

  it('crosses a month end as calendar days, not as 24-hour steps in local time', () => {
    const points = curvePoints([snapshot('2026-09-30'), snapshot('2026-10-01')]);
    expect(points.map((p) => p.date)).toEqual(['2026-09-30', '2026-10-01']);
  });

  it('carries the marker of a degraded snapshot', () => {
    const [point] = curvePoints([snapshot('2026-09-14', { degraded: true, pricedCount: 0 })]);
    expect(point).toMatchObject({ degraded: true, pricedCount: 0 });
  });

  it('draws nothing from nothing', () => {
    expect(curvePoints([])).toEqual([]);
  });
});

describe('coverageText', () => {
  it('says how many days were measured, and that the rest are gaps', () => {
    const points = curvePoints([snapshot('2026-09-27'), snapshot('2026-09-29')]);
    expect(coverageText(points)).toBe(
      '2 daily snapshots over 3 days; days without one are gaps, not estimates.',
    );
  });

  it('names the understated days', () => {
    const points = curvePoints([snapshot('2026-09-28', { degraded: true }), snapshot('2026-09-29')]);
    expect(coverageText(points)).toMatch(/1 is marked: .* understated/);
  });

  it('says when there is nothing yet, and what will produce the first point', () => {
    expect(coverageText([])).toMatch(/No daily snapshot yet/);
  });
});
