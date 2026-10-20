/**
 * When scheduled scans are due (D68, D69). The sessions are the calendar's
 * real ones: a normal day in daylight time, one in standard time, Black
 * Friday's early close, and no session on Thanksgiving.
 */

import { describe, expect, it } from 'vitest';

import {
  dueSlots,
  nextSlot,
  POST_CLOSE_LAG_MS,
  PRE_OPEN_LEAD_MS,
  slotKey,
  slotsOf,
  type Session,
} from '../src/services/scanSchedule.js';
import { HORIZON_SCHEDULES, type ScanSchedule } from '@traders/shared';

const PRE_OPEN: ScanSchedule = { everyHours: null, preOpen: true, postClose: false };
const EDGES: ScanSchedule = { everyHours: null, preOpen: true, postClose: true };
const every = (everyHours: number, edges: Partial<ScanSchedule> = {}): ScanSchedule => ({
  everyHours,
  preOpen: false,
  postClose: false,
  ...edges,
});

// 2026-10-08: New York on daylight time, open 13:30 UTC.
const SUMMER: Session = { day: '2026-10-08', opens_at: '2026-10-08T13:30:00Z', closes_at: '2026-10-08T20:00:00Z', early_close: false };
// 2026-11-25: standard time, open 14:30 UTC.
const WINTER: Session = { day: '2026-11-25', opens_at: '2026-11-25T14:30:00Z', closes_at: '2026-11-25T21:00:00Z', early_close: false };
// 2026-11-27: the day after Thanksgiving closes at 13:00 New York.
const EARLY: Session = { day: '2026-11-27', opens_at: '2026-11-27T14:30:00Z', closes_at: '2026-11-27T18:00:00Z', early_close: true };

const at = (iso: string) => new Date(iso);
const times = (slots: { slot: string; at: Date; until: Date }[]) =>
  slots.map(({ slot, at: when, until }) => `${slot} ${when.toISOString().slice(11, 16)}-${until.toISOString().slice(11, 16)}`);

describe('a schedule on one session (D68)', () => {
  it('pre-open is the open minus the lead, and runs until the close', () => {
    expect(times(slotsOf(PRE_OPEN, SUMMER))).toEqual(['pre_open 13:00-20:00']);
    expect(Date.parse(SUMMER.opens_at) - slotsOf(PRE_OPEN, SUMMER)[0]!.at.getTime()).toBe(PRE_OPEN_LEAD_MS);
  });

  it('follows the open through daylight saving: 09:00 New York either way', () => {
    expect(times(slotsOf(PRE_OPEN, WINTER))).toEqual(['pre_open 14:00-21:00']);
  });

  it('runs pre-open until the close, and post-close from the close plus the lag to midnight New York', () => {
    expect(times(slotsOf(EDGES, SUMMER))).toEqual(['pre_open 13:00-20:00', 'post_close 20:15-04:00']);
    expect(slotsOf(EDGES, SUMMER)[1]!.at.getTime() - Date.parse(SUMMER.closes_at)).toBe(POST_CLOSE_LAG_MS);
  });

  it('ends the 10:00 slot at 14:00 and the 14:00 slot at the close', () => {
    expect(times(slotsOf(every(4), SUMMER))).toEqual(['ny_1000 14:00-18:00', 'ny_1400 18:00-20:00']);
    expect(times(slotsOf(every(6), SUMMER))).toEqual(['ny_1000 14:00-20:00']);
  });

  it('runs every N hours from 10:00 while the market is open, each slot until the next (D195)', () => {
    expect(times(slotsOf(every(1), SUMMER))).toEqual([
      'ny_1000 14:00-15:00',
      'ny_1100 15:00-16:00',
      'ny_1200 16:00-17:00',
      'ny_1300 17:00-18:00',
      'ny_1400 18:00-19:00',
      'ny_1500 19:00-20:00',
    ]);
    expect(times(slotsOf(every(2), SUMMER))).toEqual(['ny_1000 14:00-16:00', 'ny_1200 16:00-18:00', 'ny_1400 18:00-20:00']);
    expect(times(slotsOf(every(5), SUMMER))).toEqual(['ny_1000 14:00-19:00', 'ny_1500 19:00-20:00']);
  });

  it('combines the edges with market hours, pre-open running until the first market scan (D195)', () => {
    expect(times(slotsOf(every(3, { preOpen: true, postClose: true }), SUMMER))).toEqual([
      'pre_open 13:00-14:00',
      'ny_1000 14:00-17:00',
      'ny_1300 17:00-20:00',
      'post_close 20:15-04:00',
    ]);
  });

  it('has no slots when nothing is scheduled: the agent scans only when asked', () => {
    expect(slotsOf({ everyHours: null, preOpen: false, postClose: false }, SUMMER)).toEqual([]);
  });

  it("gives a short horizon a market-hours schedule, and a long one the pre-open scan (D195)", () => {
    expect(HORIZON_SCHEDULES.short.everyHours).not.toBeNull();
    expect(HORIZON_SCHEDULES.long).toEqual(PRE_OPEN);
  });

  it('drops 14:00 on an early close, and moves post-close to 13:15', () => {
    expect(times(slotsOf(every(4), EARLY))).toEqual(['ny_1000 15:00-18:00']);
    expect(times(slotsOf(EDGES, EARLY))).toEqual(['pre_open 14:00-18:00', 'post_close 18:15-05:00']);
  });
});

describe('what is due now (D69)', () => {
  it('is nothing before a slot, the slot inside its window, and nothing after it', () => {
    expect(dueSlots(PRE_OPEN, [SUMMER], at('2026-10-08T12:59:00Z'))).toEqual([]);
    expect(dueSlots(PRE_OPEN, [SUMMER], at('2026-10-08T13:00:00Z')).map((s) => s.slot)).toEqual(['pre_open']);
    // A Mac asleep until mid-afternoon still catches the pre-open slot up.
    expect(dueSlots(PRE_OPEN, [SUMMER], at('2026-10-08T18:30:00Z')).map((s) => s.slot)).toEqual(['pre_open']);
    expect(dueSlots(PRE_OPEN, [SUMMER], at('2026-10-08T20:00:00Z'))).toEqual([]);
  });

  it('carries a post-close slot past midnight UTC, into its own New York day', () => {
    const due = dueSlots(EDGES, [SUMMER], at('2026-10-09T02:00:00Z'));
    expect(due).toEqual([expect.objectContaining({ day: '2026-10-08', slot: 'post_close' })]);
  });

  it('has nothing on a day with no session: a weekend or Thanksgiving', () => {
    expect(dueSlots(PRE_OPEN, [WINTER, EARLY], at('2026-11-26T15:00:00Z'))).toEqual([]);
  });

  it('names the next slot for Settings', () => {
    expect(nextSlot(PRE_OPEN, [SUMMER, WINTER], at('2026-10-08T13:05:00Z'))).toMatchObject({ day: '2026-11-25', slot: 'pre_open' });
    expect(nextSlot(every(4), [SUMMER], at('2026-10-08T15:00:00Z'))).toMatchObject({ slot: 'ny_1400' });
    expect(nextSlot(PRE_OPEN, [SUMMER], at('2026-10-08T21:00:00Z'))).toBeNull();
  });

  it('keys a slot by agent, New York day and slot', () => {
    expect(slotKey('a-1', { day: '2026-10-08', slot: 'pre_open' })).toBe('agent_scan:a-1:2026-10-08:pre_open');
  });
});
