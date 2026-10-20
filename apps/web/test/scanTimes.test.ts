/** The preview of a schedule's times on a regular trading day (D195). */

import { describe, expect, it } from 'vitest';

import { minutesUntilSoonScan, scheduleTimes, schedulesAnything, SCAN_SOON_MS } from '../src/lib/scanTimes.ts';

const iso = (dates: Date[]) => dates.map((date) => date.toISOString().slice(11, 16));

describe('scheduleTimes', () => {
  it('runs the edges and every N hours from 10:00 New York, in daylight time', () => {
    const day = new Date('2026-10-20T08:00:00Z');
    expect(iso(scheduleTimes({ everyHours: 2, preOpen: true, postClose: true }, day))).toEqual([
      '13:00',
      '14:00',
      '16:00',
      '18:00',
      '20:15',
    ]);
    expect(iso(scheduleTimes({ everyHours: 1, preOpen: false, postClose: false }, day))).toHaveLength(6);
    expect(iso(scheduleTimes({ everyHours: 6, preOpen: false, postClose: false }, day))).toEqual(['14:00']);
  });

  it('follows New York onto standard time', () => {
    expect(iso(scheduleTimes({ everyHours: 4, preOpen: false, postClose: false }, new Date('2026-11-20T12:00:00Z')))).toEqual([
      '15:00',
      '19:00',
    ]);
  });

  it('has nothing when nothing is scheduled', () => {
    const none = { everyHours: null, preOpen: false, postClose: false };
    expect(scheduleTimes(none)).toEqual([]);
    expect(schedulesAnything(none)).toBe(false);
  });
});

describe('minutesUntilSoonScan', () => {
  const now = new Date('2026-10-20T13:50:00Z');
  it('names a scan within the window, rounded up, and nothing past it or already started', () => {
    expect(minutesUntilSoonScan('2026-10-20T14:00:00Z', now)).toBe(10);
    expect(minutesUntilSoonScan(new Date(now.getTime() + SCAN_SOON_MS + 1).toISOString(), now)).toBeNull();
    expect(minutesUntilSoonScan('2026-10-20T13:40:00Z', now)).toBeNull();
    expect(minutesUntilSoonScan(null, now)).toBeNull();
  });
});
