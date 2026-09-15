import { describe, expect, it } from 'vitest';

import { ageInSeconds, formatAge, formatExactTime } from '../src/lib/relativeTime.ts';

const now = new Date('2026-09-15T10:30:00Z');

describe('formatAge', () => {
  it('describes recent, minute, hour and day scales', () => {
    expect(formatAge('2026-09-15T10:29:30Z', now)).toBe('just now');
    expect(formatAge('2026-09-15T10:15:00Z', now)).toBe('15m ago');
    expect(formatAge('2026-09-15T07:30:00Z', now)).toBe('3h ago');
    expect(formatAge('2026-09-13T10:30:00Z', now)).toBe('2d ago');
  });

  it('stays coarse, because the underlying data is not precise to the second', () => {
    expect(formatAge('2026-09-15T10:15:23Z', now)).toBe('14m ago');
  });

  it('handles missing and malformed input without throwing', () => {
    expect(formatAge(null, now)).toBe('—');
    expect(formatAge(undefined, now)).toBe('—');
    expect(formatAge('not a date', now)).toBe('just now');
    expect(formatExactTime('not a date')).toBe('unknown');
    expect(formatExactTime(null)).toBe('unknown');
  });

  it('clamps a future timestamp rather than showing a negative age', () => {
    // Clock skew between the browser and the server must not render "-3m ago".
    expect(ageInSeconds('2026-09-15T10:33:00Z', now)).toBe(0);
    expect(formatAge('2026-09-15T10:33:00Z', now)).toBe('just now');
  });
});
