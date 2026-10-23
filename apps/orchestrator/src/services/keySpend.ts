/**
 * The spend indicator's figures (D247-D250, D281): what a user's own key has
 * spent, against whichever limit binds first, and how many days are left at this
 * week's pace.
 *
 * - **The key's ratio is OpenRouter's** (D248). With a credit limit, used is
 *   `limit - limit_remaining`, in the limit's own period; with none, it is this
 *   UTC month's `usage_monthly` against "Unlimited".
 * - **The safety limit** (D250) is this app's own-key spend in the user's month
 *   against the limit they set. The bar shows whichever limit has less left.
 * - **The pace is this UTC week's** (D281): `usage_weekly` over the days since
 *   Monday 00:00 UTC, at least one. OpenRouter reports calendar windows only, no
 *   rolling 7 days, and its figure counts other apps' spend on the key.
 * - **Days left** are whole days, rounded down, against the binding limit; the
 *   warning starts at `SPEND_WARNING_DAYS` or fewer. Without a limit or without
 *   spend this week nothing is projected, so nothing warns ahead - a refusal
 *   still stops work at once (D246).
 *
 * Pure: the route gathers the reading and the month, this decides.
 */

import { SPEND_WARNING_DAYS, type KeySpend, type KeySpendPeriod } from '@traders/shared';
import type { OwnLlmKeyUsageState } from '@traders/shared/ai';

import type { MonthlySpendRow } from '../db/queries.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** OpenRouter's `limit_reset` names, as the period the ratio is labelled with. */
const PERIODS: Record<string, KeySpendPeriod> = { daily: 'day', weekly: 'week', monthly: 'month' };

/** Monday 00:00 UTC of `now`'s week. */
export function utcWeekStart(now: Date): Date {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const sinceMonday = (now.getUTCDay() + 6) % 7;
  return new Date(midnight - sinceMonday * DAY_MS);
}

/** This week's spend per day since Monday, counting at least one day; null with none. */
export function weekPaceMicroUsd(usageWeeklyMicroUsd: number, now: Date): number | null {
  if (usageWeeklyMicroUsd <= 0) return null;
  const days = Math.max(1, (now.getTime() - utcWeekStart(now).getTime()) / DAY_MS);
  return Math.round(usageWeeklyMicroUsd / days);
}

export function keySpendOf(
  state: OwnLlmKeyUsageState,
  month: MonthlySpendRow | null,
  now: Date,
): KeySpend {
  const key = !state.available ? 'unavailable' : state.key === null ? 'none' : state.key.status;
  const usage = state.usage;
  const reading: KeySpend['reading'] =
    usage === null
      ? null
      : usage.limit_micro_usd === null
        ? { usedMicroUsd: usage.usage_monthly_micro_usd, limitMicroUsd: null, period: 'month', readAt: usage.read_at }
        : {
            usedMicroUsd: usage.limit_micro_usd - (usage.limit_remaining_micro_usd ?? 0),
            limitMicroUsd: usage.limit_micro_usd,
            period: usage.limit_reset === null ? 'total' : (PERIODS[usage.limit_reset] ?? null),
            readAt: usage.read_at,
          };

  const safetyLimit: KeySpend['safetyLimit'] =
    month === null || month.safety_limit_micro_usd === null
      ? null
      : {
          limitMicroUsd: Number(month.safety_limit_micro_usd),
          spentMicroUsd: Number(month.own_key_spent_micro_usd),
          resetsOn: month.resets_on,
        };

  const keyLeft =
    reading?.limitMicroUsd != null ? Math.max(0, reading.limitMicroUsd - reading.usedMicroUsd) : null;
  const safetyLeft = safetyLimit ? Math.max(0, safetyLimit.limitMicroUsd - safetyLimit.spentMicroUsd) : null;
  const binding: KeySpend['binding'] =
    keyLeft === null && safetyLeft === null
      ? null
      : safetyLeft === null || (keyLeft !== null && keyLeft <= safetyLeft)
        ? 'key'
        : 'safety';
  const left = binding === 'key' ? keyLeft : binding === 'safety' ? safetyLeft : null;

  const dailyPaceMicroUsd = usage === null ? null : weekPaceMicroUsd(usage.usage_weekly_micro_usd, now);
  const daysLeft =
    left === null ? null : left === 0 ? 0 : dailyPaceMicroUsd === null ? null : Math.floor(left / dailyPaceMicroUsd);

  return {
    key,
    failure: state.key?.failure ?? null,
    reading,
    safetyLimit,
    binding,
    dailyPaceMicroUsd,
    daysLeft,
    warning: daysLeft !== null && daysLeft <= SPEND_WARNING_DAYS,
  };
}
