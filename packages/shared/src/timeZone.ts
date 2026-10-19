/**
 * The time-zone rule (D163), shared by the signup route and the signup form so
 * both refuse the same names: an IANA zone such as `Asia/Jerusalem` or `UTC`,
 * which the runtime's `Intl` knows. A UTC offset such as `+02:00` is refused
 * although newer engines accept it: an offset has no daylight saving, so a
 * user's "today" and quiet hours would drift by an hour twice a year.
 */

export const TIME_ZONE_MAX_LENGTH = 64;

/** Letters, digits, `_`, `-`, `+` in `/`-separated parts, starting with a letter. */
const ZONE_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;

/** Why a zone name is refused, or null. */
export function timeZoneProblem(zone: string): 'invalid' | null {
  if (zone.length > TIME_ZONE_MAX_LENGTH || !ZONE_SHAPE.test(zone)) return 'invalid';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return null;
  } catch {
    return 'invalid';
  }
}
