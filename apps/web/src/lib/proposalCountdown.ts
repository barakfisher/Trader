/**
 * How a proposal's deadline is described to the user.
 *
 * Split out of the page because it is the one piece of the inbox with a right
 * and a wrong answer, and a pure function can be tested for both. The page
 * around it is layout.
 *
 * The rounding is deliberately **downwards**. "2h left" on something with two
 * hours and fifty minutes remaining understates the time available, which costs
 * the user nothing; rounding up would show "3h left" at two hours fifty-nine,
 * and a user who reads that and comes back in three hours finds the question
 * gone. An expiry is the one number here where being optimistic is the
 * expensive direction.
 */

import { t } from '../i18n/index.ts';

/** Below this, the countdown switches to minutes: hours stop being useful. */
const MINUTES_THRESHOLD_MS = 60 * 60 * 1000;

/** Below this, it stops counting and says the deadline is imminent. */
const IMMINENT_THRESHOLD_MS = 60 * 1000;

/**
 * Time remaining, as a short phrase.
 *
 * Returns null once the deadline has passed - the caller renders the expired
 * state instead, and a negative countdown is not a thing to show anybody.
 */
export function timeLeft(expiresAt: string, now: Date = new Date()): string | null {
  const remaining = remainingDuration(expiresAt, now);
  if (remaining === null) return null;
  return remaining === 'now' ? t('countdown.expiringNow') : t('countdown.left', { duration: remaining });
}

/** The time remaining as a short duration ("2h"), 'now' inside the last minute, null once passed. */
function remainingDuration(expiresAt: string, now: Date): string | 'now' | null {
  const remaining = new Date(expiresAt).getTime() - now.getTime();
  if (Number.isNaN(remaining) || remaining <= 0) return null;
  if (remaining < IMMINENT_THRESHOLD_MS) return 'now';
  if (remaining < MINUTES_THRESHOLD_MS) {
    return t('duration.minutes', { count: Math.floor(remaining / 60_000) });
  }
  const hours = Math.floor(remaining / MINUTES_THRESHOLD_MS);
  if (hours < 24) return t('duration.hours', { count: hours });
  return t('duration.days', { count: Math.floor(hours / 24) });
}

/**
 * Whether a deadline is close enough to be worth marking in the UI.
 *
 * A threshold rather than a gradient: the only decision this drives is whether
 * to draw attention, and a colour that changes continuously communicates
 * precision the underlying number does not have.
 */
export const URGENT_THRESHOLD_MS = 60 * 60 * 1000;

export function isUrgent(expiresAt: string, now: Date = new Date()): boolean {
  const remaining = new Date(expiresAt).getTime() - now.getTime();
  return remaining > 0 && remaining < URGENT_THRESHOLD_MS;
}

/** When a snooze wakes, phrased for a line under a snoozed proposal. */
export function snoozeDescription(
  snoozedUntil: string | null,
  now: Date = new Date(),
): string | null {
  if (snoozedUntil === null) return null;
  const left = remainingDuration(snoozedUntil, now);
  // Inside the last minute the snooze is over in all but name, as it is once passed.
  return left === null || left === 'now'
    ? t('countdown.wakingNow')
    : t('countdown.snoozedUntil', { duration: left });
}
