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

import { FIRST_MARKET_SCAN_AFTER_OPEN_MINUTES, type ScanSchedule } from '@traders/shared';

import type { AgentRow } from '../db/queries.js';

/** An agent's schedule from its columns (0060). */
export function scheduleOf(row: Pick<AgentRow, 'scan_every_hours' | 'scan_pre_open' | 'scan_post_close'>): ScanSchedule {
  return { everyHours: row.scan_every_hours, preOpen: row.scan_pre_open, postClose: row.scan_post_close };
}

/**
 * A slot's name: before the open, after the close, or a market-hours time in
 * New York - `ny_1000` to `ny_1500`. The name is part of the slot's run key, so
 * 10:00 and 14:00 keep the names they had before schedules had intervals (D195).
 */
export type MarketSlot = `ny_${10 | 11 | 12 | 13 | 14 | 15}00`;
export type ScanSlot = 'pre_open' | 'post_close' | MarketSlot;

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
const HOUR = 60 * MINUTE;

/** A market-hours slot's New York time as it is written: `ny_1000` is "10:00". */
export function slotClock(slot: MarketSlot): string {
  return `${slot.slice(3, 5)}:${slot.slice(5)}`;
}

/** D68: thirty minutes before the open. */
export const PRE_OPEN_LEAD_MS = 30 * MINUTE;
/** D68: fifteen minutes after the close, an early one included. */
export const POST_CLOSE_LAG_MS = 15 * MINUTE;
/** 10:00 New York, from an open that is always 09:30 there. */
const FIRST_MARKET_SCAN_AFTER_OPEN_MS = FIRST_MARKET_SCAN_AFTER_OPEN_MINUTES * MINUTE;
/** Midnight New York, from the same 09:30 open. */
const MIDNIGHT_AFTER_OPEN_MS = 14 * 60 * MINUTE + 30 * MINUTE;
/** The hour, New York, of the first market-hours scan. */
const FIRST_MARKET_SCAN_HOUR = 10;

/**
 * One session's slots for a schedule, in the order of the day, each with its
 * window: before the open; from 10:00 every `everyHours` hours while the market
 * is open - an early close drops what falls after it; after the close.
 */
export function slotsOf(schedule: ScanSchedule, session: Session): DueSlot[] {
  const open = Date.parse(session.opens_at);
  const close = Date.parse(session.closes_at);
  const times: { slot: ScanSlot; at: number }[] = [];
  if (schedule.preOpen) times.push({ slot: 'pre_open', at: open - PRE_OPEN_LEAD_MS });
  if (schedule.everyHours !== null) {
    for (let hours = 0; ; hours += schedule.everyHours) {
      const at = open + FIRST_MARKET_SCAN_AFTER_OPEN_MS + hours * HOUR;
      if (at >= close) break;
      times.push({ slot: `ny_${FIRST_MARKET_SCAN_HOUR + hours}00` as MarketSlot, at });
    }
  }
  if (schedule.postClose) times.push({ slot: 'post_close', at: close + POST_CLOSE_LAG_MS });
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
