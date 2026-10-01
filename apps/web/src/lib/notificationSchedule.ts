/**
 * When the user is not to be disturbed, said in sentences.
 *
 * Two mechanisms, one question. Quiet hours are a recurring window in the
 * user's own local time; a mute is a single "not for the next two hours". They
 * are kept apart in the schema because a one-off written as a recurring rule
 * never gets unwritten - and they are described together here because the user
 * is reading one answer: am I going to hear from this, and when.
 *
 * Every function takes `now` as an argument rather than reading the clock, so
 * what these sentences say is testable without freezing time.
 */

import { t } from '../i18n/index.ts';

const MINUTES_PER_HOUR = 60;
const MS_PER_MINUTE = 60 * 1000;

/** The offered one-tap mutes. Anything longer is a quiet-hours change, not a mute. */
export const MUTE_PRESET_HOURS: readonly number[] = [1, 4, 24];

/** The wall-clock end of a mute started now, as the ISO 8601 UTC the API takes. */
export function muteEndingIn(hours: number, now: Date = new Date()): string {
  return new Date(now.getTime() + hours * MINUTES_PER_HOUR * MS_PER_MINUTE).toISOString();
}

/**
 * Whole minutes of mute left, and zero for a mute that has already ended.
 *
 * Zero rather than a negative number because an elapsed mute and no mute are
 * the same fact to the reader, and the server refuses to store either as one.
 */
export function muteMinutesRemaining(mutedUntil: string | null, now: Date = new Date()): number {
  if (mutedUntil === null) return 0;
  const ends = Date.parse(mutedUntil);
  if (Number.isNaN(ends)) return 0;
  return Math.max(0, Math.floor((ends - now.getTime()) / MS_PER_MINUTE));
}

export function isMuted(mutedUntil: string | null, now: Date = new Date()): boolean {
  return muteMinutesRemaining(mutedUntil, now) > 0;
}

/** `90` -> `1h 30m`. Coarse on purpose: nobody acts on the seconds of a mute. */
export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  const rest = minutes % MINUTES_PER_HOUR;
  if (hours === 0) return t('duration.minutes', { count: rest });
  if (rest === 0) return t('duration.hours', { count: hours });
  return t('duration.hoursAndMinutes', {
    hours: t('duration.hours', { count: hours }),
    minutes: t('duration.minutes', { count: rest }),
  });
}

export function describeMute(mutedUntil: string | null, now: Date = new Date()): string {
  const remaining = muteMinutesRemaining(mutedUntil, now);
  // A stored mute whose end has passed reads as live rather than as a mute of
  // zero length: the user is about to be notified, and saying otherwise would
  // be the one misleading direction for this sentence to fail in.
  if (remaining === 0) return t('mute.live');
  return t('mute.mutedFor', { duration: formatDuration(remaining) });
}

/**
 * The quiet-hours window as a sentence, including the wrap.
 *
 * A window that ends before it starts runs through midnight, which is the
 * ordinary case for sleep and the one a reader is most likely to suspect is a
 * mistake. So it is named rather than merely rendered.
 */
export function describeQuietHours(start: string | null, end: string | null): string {
  if (start === null || end === null) return t('quietHours.off');
  return end < start ? t('quietHours.overnight', { start, end }) : t('quietHours.window', { start, end });
}
