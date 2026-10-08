/**
 * When an agent's scheduled scans are due (D68, D69). Pure: sessions in, slots
 * out, with `now` an argument - a rule about 09:00 New York that can only be
 * tested by waiting for it is a rule nobody tests.
 *
 * **Every time is read from the day's session**, never from a clock in New
 * York: the calendar gives each trading day's open and close in UTC (D25), and
 * the open is 09:30 New York on every trading day - an early close moves only
 * the close. So 10:00 is the open plus 30 minutes, whatever daylight saving
 * says, and a day with no session - a weekend, a holiday - has no slots.
 *
 * **A slot has a window** (D69): from its time to the agent's next slot that
 * day, or to the close; post-close runs to midnight New York. Within the
 * window a slot runs if it never has, and retries a failure; after it, it is
 * left alone. The window is what keeps a late catch-up from overlapping the
 * next scan.
 */

import type { ScanSchedule } from '@traders/shared';

export type ScanSlot = 'pre_open' | 'post_close' | 'ny_1000' | 'ny_1400';

/** A trading day, as `GET /market/sessions` gives it. */
export interface Session {
  day: string;
  opens_at: string;
  closes_at: string;
  early_close: boolean;
}

export interface DueSlot {
  /** The New York trading day the slot belongs to (`YYYY-MM-DD`). */
  day: string;
  slot: ScanSlot;
  at: Date;
  /** The slot may start (or retry) until this moment, and not after. */
  until: Date;
}

const MINUTE = 60_000;

/** D68: thirty minutes before the open. */
export const PRE_OPEN_LEAD_MS = 30 * MINUTE;
/** D68: fifteen minutes after the close, an early one included. */
export const POST_CLOSE_LAG_MS = 15 * MINUTE;
/** 10:00 and 14:00 New York, from an open that is always 09:30 there. */
const NY_1000_AFTER_OPEN_MS = 30 * MINUTE;
const NY_1400_AFTER_OPEN_MS = 4 * 60 * MINUTE + 30 * MINUTE;
/** Midnight New York, from the same 09:30 open. */
const MIDNIGHT_AFTER_OPEN_MS = 14 * 60 * MINUTE + 30 * MINUTE;

/** Which slots each schedule runs, in the order of the day (D46's four choices). */
export const SCHEDULE_SLOTS: Record<ScanSchedule, readonly ScanSlot[]> = {
  pre_open: ['pre_open'],
  pre_open_post_close: ['pre_open', 'post_close'],
  intraday_twice: ['ny_1000', 'ny_1400'],
  intraday_once: ['ny_1000'],
};

function slotTime(slot: ScanSlot, open: number, close: number): number {
  switch (slot) {
    case 'pre_open':
      return open - PRE_OPEN_LEAD_MS;
    case 'ny_1000':
      return open + NY_1000_AFTER_OPEN_MS;
    case 'ny_1400':
      return open + NY_1400_AFTER_OPEN_MS;
    case 'post_close':
      return close + POST_CLOSE_LAG_MS;
  }
}

/** One session's slots for a schedule, each with its window. */
export function slotsOf(schedule: ScanSchedule, session: Session): DueSlot[] {
  const open = Date.parse(session.opens_at);
  const close = Date.parse(session.closes_at);
  const times = SCHEDULE_SLOTS[schedule]
    .map((slot) => ({ slot, at: slotTime(slot, open, close) }))
    // A market-hours slot after the close does not happen: 14:00 on an early close.
    .filter(({ slot, at }) => slot === 'pre_open' || slot === 'post_close' || at < close);
  return times.map(({ slot, at }, index) => {
    const next = times[index + 1]?.at;
    const end = slot === 'post_close' ? open + MIDNIGHT_AFTER_OPEN_MS : Math.min(next ?? close, close);
    return { day: session.day, slot, at: new Date(at), until: new Date(end) };
  });
}

/** The slots whose window holds `now`. Usually none; never more than one per session. */
export function dueSlots(schedule: ScanSchedule, sessions: Session[], now: Date): DueSlot[] {
  const t = now.getTime();
  return sessions
    .flatMap((session) => slotsOf(schedule, session))
    .filter((slot) => slot.at.getTime() <= t && t < slot.until.getTime());
}

/** The next slot to start after `now`, for Settings to name; null when the sessions hold none. */
export function nextSlot(schedule: ScanSchedule, sessions: Session[], now: Date): DueSlot | null {
  const t = now.getTime();
  return (
    sessions
      .flatMap((session) => slotsOf(schedule, session))
      .filter((slot) => slot.at.getTime() > t)
      .sort((a, b) => a.at.getTime() - b.at.getTime())[0] ?? null
  );
}

/** One slot's identity: the job id on the queue, and the prefix of each attempt's run key. */
export function slotKey(agentId: string, slot: Pick<DueSlot, 'day' | 'slot'>): string {
  return `agent_scan:${agentId}:${slot.day}:${slot.slot}`;
}
