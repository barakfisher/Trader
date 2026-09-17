/**
 * Notification routing: severity floors, quiet hours and mutes.
 *
 * `now` is an argument to everything under test, so nothing here waits for a
 * clock or fakes one. The cases that matter are the ones a single `between`
 * comparison gets wrong: a window that wraps midnight, a window either side of
 * a daylight-saving transition, and the boundaries themselves.
 */

import { describe, expect, it } from 'vitest';

import {
  isWithinQuietHours,
  localMinutes,
  meetsSeverity,
  notificationDedupeKey,
  parseClockTime,
  routeFinding,
  type NotificationSettings,
} from '../src/services/notificationPolicy.js';

/** The project's default zone, and one that observes DST at a different time. */
const JERUSALEM = 'Asia/Jerusalem';
const NEW_YORK = 'America/New_York';

function settings(overrides: Partial<NotificationSettings> = {}): NotificationSettings {
  return {
    notifySeverity: 'high',
    quietHoursStart: '22:00',
    quietHoursEnd: '07:00',
    mutedUntil: null,
    timezone: JERUSALEM,
    ...overrides,
  };
}

describe('parseClockTime', () => {
  it('reads a wall-clock time as minutes past midnight', () => {
    expect(parseClockTime('22:30')).toBe(22 * 60 + 30);
    expect(parseClockTime('00:00')).toBe(0);
  });

  it('returns null for a value it cannot read rather than guessing', () => {
    expect(parseClockTime(null)).toBeNull();
    expect(parseClockTime('7:00')).toBeNull();
    expect(parseClockTime('25:00')).toBeNull();
    expect(parseClockTime('22:60')).toBeNull();
    expect(parseClockTime('evening')).toBeNull();
  });
});

describe('localMinutes', () => {
  it('reports the wall-clock time in the user timezone, not UTC', () => {
    // 09:00 UTC is 12:00 in Jerusalem in September (UTC+3).
    const noonLocal = localMinutes(JERUSALEM, new Date('2026-09-17T09:00:00Z'));
    expect(noonLocal).toBe(12 * 60);
  });

  it('follows a daylight-saving transition rather than a cached offset', () => {
    // Jerusalem leaves DST in late October. The same UTC instant is a different
    // wall-clock time either side of it, which is the whole reason quiet hours
    // are stored as wall-clock times and resolved per instant.
    const summer = localMinutes(JERUSALEM, new Date('2026-09-17T09:00:00Z'));
    const winter = localMinutes(JERUSALEM, new Date('2026-12-17T09:00:00Z'));
    expect(summer).not.toBe(winter);
  });

  it('reads midnight as the start of the day, not the end', () => {
    // `hour12: false` renders midnight as 24 in some ICU builds. Only one of 0
    // and 1440 is less than a day's worth of minutes.
    expect(localMinutes(JERUSALEM, new Date('2026-09-16T21:00:00Z'))).toBe(0);
  });
});

describe('isWithinQuietHours', () => {
  /** 2026-09-17, at a given Jerusalem wall-clock hour (UTC+3 that month). */
  const jerusalemAt = (hour: number, minute = 0) =>
    new Date(Date.UTC(2026, 8, 17, hour - 3, minute));

  it('is quiet in the middle of a window that wraps midnight', () => {
    // The default window, and the case a naive `start <= t && t < end` makes
    // permanently empty.
    expect(isWithinQuietHours(settings(), jerusalemAt(2))).toBe(true);
  });

  it('is quiet late in the evening, before midnight', () => {
    expect(isWithinQuietHours(settings(), jerusalemAt(23))).toBe(true);
  });

  it('is awake during the day', () => {
    expect(isWithinQuietHours(settings(), jerusalemAt(12))).toBe(false);
  });

  it('treats the window as half-open: quiet at the start, awake at the end', () => {
    expect(isWithinQuietHours(settings(), jerusalemAt(22))).toBe(true);
    expect(isWithinQuietHours(settings(), jerusalemAt(7))).toBe(false);
  });

  it('handles a window that does not wrap midnight', () => {
    const daytime = settings({ quietHoursStart: '09:00', quietHoursEnd: '17:00' });
    expect(isWithinQuietHours(daytime, jerusalemAt(12))).toBe(true);
    expect(isWithinQuietHours(daytime, jerusalemAt(20))).toBe(false);
  });

  it('has no quiet hours when both ends are unset', () => {
    const always = settings({ quietHoursStart: null, quietHoursEnd: null });
    expect(isWithinQuietHours(always, jerusalemAt(3))).toBe(false);
  });

  it('falls back to no quiet hours when only one end survives', () => {
    // The database refuses a half-set window, so reaching here means the row
    // was hand-edited. Delivering an alert the user might not have wanted is
    // the cheap direction; silencing one they were waiting for is not.
    const half = settings({ quietHoursEnd: null });
    expect(isWithinQuietHours(half, jerusalemAt(3))).toBe(false);
  });

  it('treats a zero-length window as no window at all', () => {
    // Otherwise the wrapping branch reads 09:00-09:00 as permanently quiet,
    // which is a silent outage produced by a plausible typo.
    const empty = settings({ quietHoursStart: '09:00', quietHoursEnd: '09:00' });
    expect(isWithinQuietHours(empty, jerusalemAt(9))).toBe(false);
    expect(isWithinQuietHours(empty, jerusalemAt(3))).toBe(false);
  });

  it('judges the window in the user timezone, not the server one', () => {
    // The same instant: night in Jerusalem, afternoon in New York. A server
    // resolving quiet hours in UTC would be quiet at the wrong time for one of
    // these users all year and for both of them half the year.
    const instant = new Date('2026-09-16T23:00:00Z');
    expect(isWithinQuietHours(settings(), instant)).toBe(true);
    expect(isWithinQuietHours(settings({ timezone: NEW_YORK }), instant)).toBe(false);
  });
});

describe('meetsSeverity', () => {
  it('admits a severity at or above the floor', () => {
    expect(meetsSeverity('high', 'notable')).toBe(true);
    expect(meetsSeverity('notable', 'notable')).toBe(true);
  });

  it('rejects one below the floor', () => {
    expect(meetsSeverity('info', 'high')).toBe(false);
  });

  it('rejects a severity it cannot read rather than admitting it', () => {
    expect(meetsSeverity('catastrophic', 'info')).toBe(false);
  });
});

describe('routeFinding', () => {
  const daytime = new Date('2026-09-17T09:00:00Z'); // noon in Jerusalem
  const night = new Date('2026-09-16T23:00:00Z'); // 02:00 in Jerusalem

  it('pushes a finding at or above the floor, outside quiet hours', () => {
    expect(routeFinding('high', settings(), daytime)).toEqual({
      route: 'push',
      reason: 'above_floor',
    });
  });

  it('defers rather than drops a finding that arrives during quiet hours', () => {
    // The single idea this module is built around: an alert that vanishes is
    // indistinguishable from a market that did nothing.
    expect(routeFinding('high', settings(), night)).toEqual({
      route: 'digest',
      reason: 'quiet_hours',
    });
  });

  it('digests a finding below the floor', () => {
    expect(routeFinding('notable', settings(), daytime)).toEqual({
      route: 'digest',
      reason: 'below_floor',
    });
  });

  it('digests rather than discards while muted', () => {
    // /mute means "stop interrupting me", not "pretend this did not happen" -
    // the second reading would make the quietest possible failure a setting the
    // user chose themselves.
    const muted = settings({ mutedUntil: new Date(daytime.getTime() + 3_600_000) });
    expect(routeFinding('high', muted, daytime)).toEqual({ route: 'digest', reason: 'muted' });
  });

  it('pushes again once a mute has elapsed', () => {
    const expired = settings({ mutedUntil: new Date(daytime.getTime() - 1_000) });
    expect(routeFinding('high', expired, daytime).route).toBe('push');
  });

  it('reports the floor, not the hour, when a finding is both quiet and low', () => {
    // Both end in the digest, but only one is a fact about the finding itself -
    // and the reason is what the user is shown when they ask why they did not
    // hear about something.
    expect(routeFinding('info', settings(), night).reason).toBe('below_floor');
  });

  it('lets a mute outrank a severity floor set weeks earlier', () => {
    const muted = settings({
      notifySeverity: 'info',
      mutedUntil: new Date(daytime.getTime() + 3_600_000),
    });
    expect(routeFinding('info', muted, daytime).reason).toBe('muted');
  });
});

describe('notificationDedupeKey', () => {
  it('is stable for the same finding on the same channel', () => {
    // A key that varied with the clock would deduplicate nothing, which is the
    // failure it exists to prevent - and a sent message cannot be recalled.
    const first = notificationDedupeKey('telegram', 'observation', 'obs-1');
    const second = notificationDedupeKey('telegram', 'observation', 'obs-1');
    expect(first).toBe(second);
  });

  it('separates the same finding on different channels', () => {
    expect(notificationDedupeKey('telegram', 'observation', 'obs-1')).not.toBe(
      notificationDedupeKey('digest', 'observation', 'obs-1'),
    );
  });

  it('separates different findings on one channel', () => {
    expect(notificationDedupeKey('telegram', 'observation', 'obs-1')).not.toBe(
      notificationDedupeKey('telegram', 'observation', 'obs-2'),
    );
  });
});
