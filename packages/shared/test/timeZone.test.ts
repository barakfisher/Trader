import { describe, expect, it } from 'vitest';

import { TIME_ZONE_MAX_LENGTH, timeZoneProblem } from '../src/timeZone.js';

describe('timeZoneProblem', () => {
  it.each(['Asia/Jerusalem', 'America/New_York', 'UTC', 'America/Argentina/Buenos_Aires', 'Etc/GMT+2'])(
    'accepts the IANA zone %s',
    (zone) => expect(timeZoneProblem(zone)).toBeNull(),
  );

  it.each(['', '+02:00', 'Asia/Atlantis', 'asia jerusalem', '../etc/passwd', 'Asia//Jerusalem'])(
    'refuses %j',
    (zone) => expect(timeZoneProblem(zone)).toBe('invalid'),
  );

  it('refuses a name past the ceiling', () => {
    expect(timeZoneProblem(`A/${'b'.repeat(TIME_ZONE_MAX_LENGTH)}`)).toBe('invalid');
  });
});
