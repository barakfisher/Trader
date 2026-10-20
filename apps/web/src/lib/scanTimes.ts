/**
 * When a schedule's scans fall on a regular trading day, as instants the page
 * shows in the user's own time (D195). The orchestrator decides when scans
 * really run, from each day's session (`scanSchedule.ts`); this is the preview
 * beside the control - the same rules on a 09:30-16:00 New York day - so the
 * user sees "16:00, 17:00, 19:00" rather than doing time-zone arithmetic.
 */

import {
  FIRST_MARKET_SCAN_AFTER_OPEN_MINUTES,
  REGULAR_SESSION_MINUTES,
  type ScanSchedule,
} from '@traders/shared';

const NEW_YORK = 'America/New_York';
const MINUTE = 60_000;
const OPEN_MINUTES = 9 * 60 + 30;
/** D68: thirty minutes before the open, fifteen after the close. */
const PRE_OPEN_LEAD_MINUTES = 30;
const POST_CLOSE_LAG_MINUTES = 15;

/** Minutes east of UTC that New York keeps at `when` ("GMT-04:00" is -240). */
function newYorkOffsetMinutes(when: Date): number {
  const zone = new Intl.DateTimeFormat('en-US', { timeZone: NEW_YORK, timeZoneName: 'longOffset' })
    .formatToParts(when)
    .find((part) => part.type === 'timeZoneName')?.value;
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(zone ?? '');
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === '-' ? -minutes : minutes;
}

/** The instant of `minutes` after midnight New York, on New York's date at `day`. */
function newYorkMinute(day: Date, minutes: number): Date {
  const [year, month, date] = new Intl.DateTimeFormat('en-CA', { timeZone: NEW_YORK })
    .format(day)
    .split('-')
    .map(Number);
  const wall = Date.UTC(year!, month! - 1, date!, 0, minutes);
  return new Date(wall - newYorkOffsetMinutes(new Date(wall)) * MINUTE);
}

/** The schedule's scans on a regular trading day on `day`'s New York date, in the order of the day. */
export function scheduleTimes(schedule: ScanSchedule, day: Date = new Date()): Date[] {
  const close = OPEN_MINUTES + REGULAR_SESSION_MINUTES;
  const minutes: number[] = [];
  if (schedule.preOpen) minutes.push(OPEN_MINUTES - PRE_OPEN_LEAD_MINUTES);
  if (schedule.everyHours !== null) {
    for (let at = OPEN_MINUTES + FIRST_MARKET_SCAN_AFTER_OPEN_MINUTES; at < close; at += schedule.everyHours * 60) {
      minutes.push(at);
    }
  }
  if (schedule.postClose) minutes.push(close + POST_CLOSE_LAG_MINUTES);
  return minutes.map((minute) => newYorkMinute(day, minute));
}

/** Whether a schedule runs anything at all: all three off is manual only. */
export function schedulesAnything(schedule: ScanSchedule): boolean {
  return schedule.everyHours !== null || schedule.preOpen || schedule.postClose;
}

export function sameSchedule(a: ScanSchedule, b: ScanSchedule): boolean {
  return a.everyHours === b.everyHours && a.preOpen === b.preOpen && a.postClose === b.postClose;
}

/** D195: a scheduled scan this close is worth naming beside *Run a scan now*. */
export const SCAN_SOON_MS = 30 * MINUTE;

/** Minutes until the next scheduled scan, when it is within `SCAN_SOON_MS`; else null. */
export function minutesUntilSoonScan(nextAt: string | null | undefined, now: Date = new Date()): number | null {
  if (!nextAt) return null;
  const until = Date.parse(nextAt) - now.getTime();
  return until > 0 && until <= SCAN_SOON_MS ? Math.ceil(until / MINUTE) : null;
}
