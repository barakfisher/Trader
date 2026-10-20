import { afterEach, describe, expect, it } from 'vitest';

import { i18n } from '../src/i18n/index.ts';
import { capResetLabel, capResetsOn, formatResetDate } from '../src/lib/monthlyCap.ts';
import { setDisplayTimeZone } from '../src/lib/relativeTime.ts';

describe("the monthly cap's reset date (D157)", () => {
  afterEach(async () => {
    setDisplayTimeZone(null);
    await i18n.changeLanguage('en');
  });

  it("is the first day of the next month in the user's zone", () => {
    setDisplayTimeZone('Asia/Jerusalem');
    // 22:30 UTC on 31 October is already November in Jerusalem.
    expect(capResetsOn(new Date('2026-10-31T21:30:00Z'))).toBe('2026-11-01');
    expect(capResetsOn(new Date('2026-10-31T22:30:00Z'))).toBe('2026-12-01');
    expect(capResetsOn(new Date('2026-12-15T12:00:00Z'))).toBe('2027-01-01');
  });

  it('prints a calendar date in the interface language, whatever the zone', async () => {
    setDisplayTimeZone('Pacific/Kiritimati');
    expect(formatResetDate('2026-11-01')).toBe('1 November 2026');
    expect(capResetLabel('2026-10-12T08:00:00Z')).toBe('1 November 2026');
    await i18n.changeLanguage('he');
    expect(formatResetDate('2026-11-01')).toContain('2026');
    expect(formatResetDate('2026-11-01')).toContain('נובמבר');
  });
});
