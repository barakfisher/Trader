import { describe, expect, it } from 'vitest';

import type { DailyClose } from '@traders/shared';

import {
  MAX_CLOSED_DAYS,
  chartPoints,
  coverageText,
  daysBetween,
  inRange,
  missingStretches,
  rangeChange,
} from '../src/lib/priceChart.ts';

const close = (day: string, priceMinor: number, currency = 'USD'): DailyClose => ({
  day,
  priceMinor,
  currency,
  asOf: `${day}T20:00:00.000Z`,
});

/** Weekdays of two weeks: Friday to Monday is three days, which is not a gap. */
const TWO_WEEKS = [
  close('2026-09-14', 100),
  close('2026-09-15', 101),
  close('2026-09-16', 102),
  close('2026-09-17', 103),
  close('2026-09-18', 104),
  close('2026-09-21', 105),
  close('2026-09-22', 106),
];

describe('chartPoints', () => {
  it('draws a weekend as a closed market, not as a break', () => {
    const points = chartPoints(TWO_WEEKS);
    expect(points.every((point) => point.priceMinor !== null)).toBe(true);
    expect(points).toHaveLength(TWO_WEEKS.length);
  });

  it('breaks the line where closes are further apart than any closure explains', () => {
    const later = new Date(Date.parse('2026-09-22T00:00:00Z') + (MAX_CLOSED_DAYS + 1) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const points = chartPoints([...TWO_WEEKS, close(later, 110)]);
    expect(points.filter((point) => point.priceMinor === null)).toHaveLength(1);
    expect(points.at(-2)?.priceMinor).toBeNull();
    expect(missingStretches([...TWO_WEEKS, close(later, 110)])).toBe(1);
  });

  it('keeps a gap of exactly the longest closure unbroken', () => {
    const edge = new Date(Date.parse('2026-09-22T00:00:00Z') + MAX_CLOSED_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);
    expect(chartPoints([...TWO_WEEKS, close(edge, 110)]).some((p) => p.priceMinor === null)).toBe(
      false,
    );
  });
});

describe('inRange', () => {
  it('counts back from the last close, not from today', () => {
    expect(inRange(TWO_WEEKS, '1m')).toEqual(TWO_WEEKS);
    const long = [close('2026-06-01', 90), ...TWO_WEEKS];
    expect(inRange(long, '1m')).toEqual(TWO_WEEKS);
    expect(inRange(long, 'all')).toEqual(long);
  });

  it('is empty for no closes', () => {
    expect(inRange([], '3m')).toEqual([]);
  });
});

describe('rangeChange', () => {
  it('is the last close less the first, in minor units', () => {
    expect(rangeChange(TWO_WEEKS)).toMatchObject({ changeMinor: 6, changePct: 6 });
  });

  it('is nothing for one close, or closes in two currencies', () => {
    expect(rangeChange([close('2026-09-14', 100)])).toBeNull();
    expect(rangeChange([close('2026-09-14', 100), close('2026-09-15', 90, 'EUR')])).toBeNull();
  });
});

describe('coverageText', () => {
  it('says an empty chart is nothing stored, not a failure', () => {
    expect(coverageText([])).toMatch(/No stored closing price yet/);
  });

  it('names the span and that only stored prices are drawn', () => {
    expect(coverageText(TWO_WEEKS)).toBe(
      '7 daily closes from 14 Sept 2026 to 22 Sept 2026; stored prices only.',
    );
  });
});

it('counts calendar days whatever the process timezone', () => {
  expect(daysBetween('2026-09-18', '2026-09-21')).toBe(3);
});

describe('a day not yet closed', () => {
  const now = new Date('2026-09-30T07:00:00Z');

  it('is named as today so far, and a finished day by its date', async () => {
    const { dayName } = await import('../src/lib/priceChart.ts');
    expect(dayName('2026-09-30', now)).toBe('30 Sept 2026 (so far today)');
    expect(dayName('2026-09-29', now)).toBe('29 Sept 2026');
  });
});

describe('levelPosition', () => {
  it('says whether a cost is on the chart or off one edge', async () => {
    const { levelPosition } = await import('../src/lib/priceChart.ts');
    expect(levelPosition(98, TWO_WEEKS)).toBe('below');
    expect(levelPosition(103, TWO_WEEKS)).toBe('within');
    expect(levelPosition(200, TWO_WEEKS)).toBe('above');
  });
});

