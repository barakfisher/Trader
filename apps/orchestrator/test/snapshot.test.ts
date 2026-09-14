import { describe, expect, it } from 'vitest';

import { localDate } from '../src/services/snapshot.js';

describe('localDate', () => {
  it('uses the user timezone, not the server timezone', () => {
    // 21:30 UTC is already the next day in Israel (UTC+3 in September).
    const instant = new Date('2026-09-14T21:30:00Z');
    expect(localDate('Asia/Jerusalem', instant)).toBe('2026-09-15');
    expect(localDate('UTC', instant)).toBe('2026-09-14');
    expect(localDate('America/New_York', instant)).toBe('2026-09-14');
  });
});
