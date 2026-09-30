import { afterEach, expect, it } from 'vitest';

import {
  formatClockTime,
  formatExactTime,
  getDisplayTimeZone,
  setDisplayTimeZone,
} from '../src/lib/relativeTime.ts';

afterEach(() => setDisplayTimeZone(null));

// 10:18:01 UTC, which is 13:18:01 in Jerusalem (UTC+3 in September).
const RECORDED = '2026-09-28T10:18:01.000Z';

it('shows a time in the user’s timezone, day first, 24-hour, with the zone named', () => {
  setDisplayTimeZone('Asia/Jerusalem');
  expect(formatExactTime(RECORDED)).toBe('28 Sept 2026, 13:18:01 GMT+3');
  expect(formatClockTime(RECORDED)).toBe('13:18');
});

it('does not depend on the zone the browser happens to be in', () => {
  setDisplayTimeZone('America/New_York');
  expect(formatExactTime(RECORDED)).toBe('28 Sept 2026, 06:18:01 GMT-4');
});

it('names UTC when no user zone is known, and refuses a zone that does not exist', () => {
  expect(formatExactTime(RECORDED)).toBe('28 Sept 2026, 10:18:01 UTC');
  setDisplayTimeZone('Mars/Olympus_Mons');
  expect(getDisplayTimeZone()).toBe('UTC');
});

it('keeps an unknown time unknown', () => {
  expect(formatExactTime(null)).toBe('unknown');
  expect(formatExactTime('not a time')).toBe('unknown');
});

it('follows the signed-in user, and forgets the zone on sign-out', async () => {
  const { RootStore } = await import('../src/stores/RootStore.ts');
  const root = new RootStore();
  root.auth.user = { id: 'u', baseCurrency: 'USD', timezone: 'Asia/Jerusalem' } as never;
  expect(getDisplayTimeZone()).toBe('Asia/Jerusalem');
  root.auth.user = null;
  expect(getDisplayTimeZone()).toBe('UTC');
});
