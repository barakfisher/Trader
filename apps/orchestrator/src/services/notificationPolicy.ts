/**
 * Who gets told what, and when. Pure functions, no database and no clock.
 *
 * Everything here takes `now` as an argument for the same reason the proposal
 * state machine does: a rule about quiet hours that can only be tested by
 * waiting until 22:00 is a rule nobody tests.
 *
 * **Nothing is ever dropped.** This is the single idea the module is built
 * around. An alert that arrives at 03:00 is *deferred* into the next digest, not
 * discarded - because a notification that vanishes is indistinguishable from a
 * market that did nothing, and that confusion is the exact failure this product
 * keeps designing against. Quiet hours change *when* the user hears, never
 * *whether*. The one exception is an explicit mute, which is the user saying
 * "not this", and even then the finding stays in the feed.
 */

/** Severities, weakest first. Mirrors SEVERITY_ORDER in the AI service. */
export const SEVERITY_RANK: Record<string, number> = { info: 0, notable: 1, high: 2 };

/**
 * Where a finding goes.
 *
 * `push` is an interruption - a Telegram message now. `digest` is the daily
 * summary. `feed_only` means it is worth recording and not worth sending, which
 * is a real answer and not a failure: the observations feed already has it.
 */
export type NotificationRoute = 'push' | 'digest' | 'feed_only';

export interface NotificationSettings {
  notifySeverity: string;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  mutedUntil: Date | null;
  /** IANA zone. Quiet hours are wall-clock, so they are meaningless without it. */
  timezone: string;
}

export interface RoutingDecision {
  route: NotificationRoute;
  /**
   * Why, in a form the run stats and the logs can carry. A digest entry that
   * arrives without saying it was deferred looks like a late alert rather than
   * a respected preference, and the operator answering "why didn't I get this?"
   * needs the reason more than the routing.
   */
  reason: 'above_floor' | 'below_floor' | 'quiet_hours' | 'muted';
}

/**
 * The user's local wall-clock time as minutes past midnight.
 *
 * Wall clock, not UTC offset arithmetic: `Intl` resolves the zone's rules for
 * *this* instant, so a DST transition is handled by the platform's timezone
 * database rather than by an offset we cached. `localDate` in snapshot.ts reads
 * the calendar day the same way, for the same reason.
 */
export function localMinutes(timezone: string, now: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');
  // `hour12: false` renders midnight as 24 in some ICU versions and 00 in
  // others. Both mean the same instant, and only one of them is less than a
  // day's worth of minutes.
  return (hour % 24) * 60 + minute;
}

/** `HH:MM` to minutes past midnight, or null when the value is unusable. */
export function parseClockTime(value: string | null): number | null {
  if (value === null) return null;
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (match === null) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * Is `now` inside the user's quiet window?
 *
 * The window normally wraps midnight - 22:00 to 07:00 is the default, and a
 * night that did not wrap would be the unusual one. So the comparison is an OR
 * when start > end and an AND otherwise, rather than the single `between` that
 * silently makes every overnight window empty.
 *
 * The window is half-open: quiet at exactly 22:00, awake at exactly 07:00. A
 * closed window would make a one-minute window mean two minutes, and one of the
 * two ends has to be chosen anyway.
 */
export function isWithinQuietHours(
  settings: Pick<NotificationSettings, 'quietHoursStart' | 'quietHoursEnd' | 'timezone'>,
  now: Date,
): boolean {
  const start = parseClockTime(settings.quietHoursStart);
  const end = parseClockTime(settings.quietHoursEnd);
  // Both null means no quiet hours; one null is a half-set window the database
  // refuses, so reaching here with one means the value was hand-edited. Treated
  // as "no quiet hours" rather than as an error: the cheap direction to be
  // wrong in is delivering an alert the user might not have wanted, not
  // silencing one they were waiting for.
  if (start === null || end === null) return false;
  // A zero-length window is not a window. Without this, 09:00-09:00 would read
  // as "quiet for exactly no time", which is true and useless, or as "always
  // quiet" under the wrapping branch, which is a silent outage.
  if (start === end) return false;

  const minutes = localMinutes(settings.timezone, now);
  return start > end
    ? minutes >= start || minutes < end // wraps midnight
    : minutes >= start && minutes < end;
}

export function meetsSeverity(severity: string, floor: string): boolean {
  const rank = SEVERITY_RANK[severity];
  const floorRank = SEVERITY_RANK[floor];
  // An unreadable severity is routed as if it were below the floor rather than
  // above it: it still reaches the feed, it just does not interrupt anybody.
  if (rank === undefined || floorRank === undefined) return false;
  return rank >= floorRank;
}

/**
 * Decide where one finding goes.
 *
 * The order of the checks is the policy. A mute is checked first because it is
 * the user's most recent and most explicit instruction, and it outranks a
 * severity they set weeks ago. Severity is checked before quiet hours so that
 * something below the floor reads as `below_floor` rather than as
 * `quiet_hours` - both end in the digest, but only one of them is a fact about
 * the finding, and the reason is what the user is shown when they ask why they
 * did not hear about something.
 */
export function routeFinding(
  severity: string,
  settings: NotificationSettings,
  now: Date,
): RoutingDecision {
  if (settings.mutedUntil !== null && settings.mutedUntil.getTime() > now.getTime()) {
    // Deliberately still a digest entry rather than nothing at all: /mute means
    // "stop interrupting me", and reading it as "pretend this did not happen"
    // would make the quietest possible failure the user's own setting.
    return { route: 'digest', reason: 'muted' };
  }
  if (!meetsSeverity(severity, settings.notifySeverity)) {
    return { route: 'digest', reason: 'below_floor' };
  }
  if (isWithinQuietHours(settings, now)) {
    return { route: 'digest', reason: 'quiet_hours' };
  }
  return { route: 'push', reason: 'above_floor' };
}

/**
 * The dedupe key for one notification.
 *
 * Built from the thing being announced and the channel it goes to, and
 * deliberately *not* from the time: a key that varies with the clock
 * deduplicates nothing, which is the failure it exists to prevent. The
 * observation's own `dedupe_key` already collapses a repeated finding, so this
 * only has to stop the same finding being sent twice down the same channel -
 * after a retry, a restart mid-fan-out, or a digest that overlaps a push.
 *
 * `notifications.dedupe_key` is UNIQUE, so this is a guarantee rather than a
 * convention. It has to be, because a sent message cannot be recalled.
 */
export function notificationDedupeKey(
  channel: string,
  refKind: string,
  refId: string,
): string {
  return `${channel}:${refKind}:${refId}`;
}
