/**
 * The spend indicator's figures (D247-D250, D281): OpenRouter's ratio in its own
 * period, the limit that binds first, this week's pace and the five-day warning.
 */

import { describe, expect, it } from 'vitest';

import { SPEND_WARNING_DAYS } from '@traders/shared';
import type { OwnLlmKeyUsageState } from '@traders/shared/ai';

import { keySpendOf, utcWeekStart, weekPaceMicroUsd } from '../src/services/keySpend.js';

const DOLLAR = 1_000_000;
/** Thursday 2026-10-22 12:00 UTC: three and a half days into the UTC week. */
const THURSDAY_NOON = new Date('2026-10-22T12:00:00Z');
const DAYS_INTO_WEEK = 3.5;
const KEY = { last_four: 'c0de', status: 'valid' as const, saved_at: '2026-10-20T12:00:00Z', failed_at: null, failure: null };

function state(usage: Partial<NonNullable<OwnLlmKeyUsageState['usage']>> | null): OwnLlmKeyUsageState {
  return {
    available: true,
    key: KEY,
    usage:
      usage === null
        ? null
        : {
            limit_micro_usd: 50 * DOLLAR,
            limit_remaining_micro_usd: 38 * DOLLAR,
            limit_reset: 'monthly',
            usage_daily_micro_usd: 0,
            usage_weekly_micro_usd: 0,
            usage_monthly_micro_usd: 12 * DOLLAR,
            read_at: '2026-10-22T11:55:00Z',
            ...usage,
          },
  };
}

const month = (limit: number | null, spent: number) => ({
  own_key_spent_micro_usd: String(spent),
  safety_limit_micro_usd: limit === null ? null : String(limit),
  resets_on: '2026-11-01',
});

describe('the week', () => {
  it('starts Monday 00:00 UTC, and a Monday counts as one day at least', () => {
    expect(utcWeekStart(THURSDAY_NOON).toISOString()).toBe('2026-10-19T00:00:00.000Z');
    expect(utcWeekStart(new Date('2026-10-25T23:59:00Z')).toISOString()).toBe('2026-10-19T00:00:00.000Z');
    expect(weekPaceMicroUsd(7 * DOLLAR, THURSDAY_NOON)).toBe(Math.round((7 * DOLLAR) / DAYS_INTO_WEEK));
    expect(weekPaceMicroUsd(3 * DOLLAR, new Date('2026-10-19T02:00:00Z'))).toBe(3 * DOLLAR);
    expect(weekPaceMicroUsd(0, THURSDAY_NOON)).toBeNull();
  });
});

describe('the ratio (D248)', () => {
  it('with a limit is limit minus remaining, in the limit’s own period', () => {
    const spend = keySpendOf(state({}), null, THURSDAY_NOON);
    expect(spend.reading).toMatchObject({ usedMicroUsd: 12 * DOLLAR, limitMicroUsd: 50 * DOLLAR, period: 'month' });
    expect(keySpendOf(state({ limit_reset: null }), null, THURSDAY_NOON).reading?.period).toBe('total');
    expect(keySpendOf(state({ limit_reset: 'weekly' }), null, THURSDAY_NOON).reading?.period).toBe('week');
  });

  it('without one is this month’s spend against Unlimited, and nothing is projected', () => {
    const spend = keySpendOf(
      state({ limit_micro_usd: null, limit_remaining_micro_usd: null, limit_reset: null, usage_weekly_micro_usd: DOLLAR }),
      null,
      THURSDAY_NOON,
    );
    expect(spend.reading).toMatchObject({ usedMicroUsd: 12 * DOLLAR, limitMicroUsd: null, period: 'month' });
    expect([spend.binding, spend.daysLeft, spend.warning]).toEqual([null, null, false]);
  });
});

describe('days left and the warning (D246, D281)', () => {
  it('projects the binding limit at this week’s pace, rounded down', () => {
    // $38 left at $2 a day this week: 19 days.
    const spend = keySpendOf(state({ usage_weekly_micro_usd: 7 * DOLLAR }), null, THURSDAY_NOON);
    expect(spend.dailyPaceMicroUsd).toBe(2 * DOLLAR);
    expect([spend.binding, spend.daysLeft, spend.warning]).toEqual(['key', 19, false]);
  });

  it(`warns at ${SPEND_WARNING_DAYS} days or fewer, and at nothing left`, () => {
    const pace = 7 * DOLLAR; // $2 a day
    const atEdge = keySpendOf(state({ limit_remaining_micro_usd: SPEND_WARNING_DAYS * 2 * DOLLAR, usage_weekly_micro_usd: pace }), null, THURSDAY_NOON);
    expect([atEdge.daysLeft, atEdge.warning]).toEqual([SPEND_WARNING_DAYS, true]);
    const past = keySpendOf(state({ limit_remaining_micro_usd: (SPEND_WARNING_DAYS + 1) * 2 * DOLLAR, usage_weekly_micro_usd: pace }), null, THURSDAY_NOON);
    expect(past.warning).toBe(false);
    const spent = keySpendOf(state({ limit_remaining_micro_usd: 0 }), null, THURSDAY_NOON);
    expect([spent.daysLeft, spent.warning]).toEqual([0, true]);
  });

  it('says nothing ahead with no spend this week', () => {
    const spend = keySpendOf(state({ usage_weekly_micro_usd: 0 }), null, THURSDAY_NOON);
    expect([spend.dailyPaceMicroUsd, spend.daysLeft, spend.warning]).toEqual([null, null, false]);
  });
});

describe('the safety limit (D250)', () => {
  it('binds when it has less left than the key, even on an unlimited key', () => {
    const pace = 7 * DOLLAR;
    const tighter = keySpendOf(state({ usage_weekly_micro_usd: pace }), month(20 * DOLLAR, 14 * DOLLAR), THURSDAY_NOON);
    expect(tighter.safetyLimit).toEqual({ limitMicroUsd: 20 * DOLLAR, spentMicroUsd: 14 * DOLLAR, resetsOn: '2026-11-01' });
    expect([tighter.binding, tighter.daysLeft, tighter.warning]).toEqual(['safety', 3, true]);

    const unlimited = keySpendOf(
      state({ limit_micro_usd: null, limit_remaining_micro_usd: null, usage_weekly_micro_usd: pace }),
      month(20 * DOLLAR, 0),
      THURSDAY_NOON,
    );
    expect([unlimited.binding, unlimited.daysLeft]).toEqual(['safety', 10]);
  });

  it('leaves the key binding when the key has less left', () => {
    const spend = keySpendOf(state({}), month(500 * DOLLAR, 0), THURSDAY_NOON);
    expect(spend.binding).toBe('key');
  });
});

describe('a key that does not work', () => {
  it('says which, with no reading', () => {
    expect(keySpendOf({ available: true, key: null, usage: null }, null, THURSDAY_NOON).key).toBe('none');
    expect(keySpendOf({ available: false, key: null, usage: null }, null, THURSDAY_NOON).key).toBe('unavailable');
    const failed = keySpendOf(
      { available: true, key: { ...KEY, status: 'failed', failure: 'no_credit', failed_at: '2026-10-22T10:00:00Z' }, usage: null },
      null,
      THURSDAY_NOON,
    );
    expect([failed.key, failed.failure, failed.reading]).toEqual(['failed', 'no_credit', null]);
  });
});
