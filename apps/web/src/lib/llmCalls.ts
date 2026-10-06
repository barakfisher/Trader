/**
 * How model calls read on the admin page. Kept apart from the component so
 * the wording and the arithmetic can be tested.
 */

import type {
  LlmPurposeSummary,
  LlmCallOutcome,
  LlmCallSummary,
  LlmCallVerdict,
} from '@traders/shared';

import { formatFixed, formatNumber } from '../i18n/format.ts';
import { i18n, t, translatedRecord } from '../i18n/index.ts';

/** The windows the card offers; the server accepts any whole number up to its retention. */
export const LLM_WINDOWS = [1, 7, 30] as const;

export const OUTCOME_LABEL: Record<LlmCallOutcome, string> = translatedRecord(
  ['ok', 'provider_error', 'budget_exhausted', 'no_provider'],
  (outcome) => t(`llm.outcomes.${outcome}`),
);

export const VERDICT_LABEL: Record<LlmCallVerdict, string> = translatedRecord(
  ['accepted', 'malformed', 'unsourced_figures', 'empty_completion', 'degenerate_completion', 'not_judged'],
  (verdict) => t(`llm.verdicts.${verdict}`),
);

/** An `observations.fallback_reason`, as an operator would say it; an unknown one as it is. */
export function reasonLabel(reason: string): string {
  return i18n.exists(`llm.reasons.${reason}`) ? t(`llm.reasons.${reason as 'none'}`) : reason;
}

/** The non-zero entries of a count map, largest first, labelled. */
export function nonZero<K extends string>(
  counts: Record<K, number>,
  labels: Record<K, string>,
): { key: K; label: string; count: number }[] {
  return (Object.entries(counts) as [K, number][])
    .filter(([, count]) => count > 0)
    .map(([key, count]) => ({ key, label: labels[key] ?? key, count }))
    .sort((a, b) => b.count - a.count);
}

const MICRO_PER_TEN_THOUSANDTH = 100;
const TEN_THOUSANDTHS_PER_DOLLAR = 10_000;

/**
 * Integer micro-USD as dollars to four places - a cheap call costs fractions
 * of a cent, and two places would show most of them as $0.00. Rounded once,
 * here, with integer arithmetic (guideline 3).
 */
export function formatMicroUsd(micro: number): string {
  if (micro === 0) return usd(0, 0, 0);
  const units = Math.round(micro / MICRO_PER_TEN_THOUSANDTH);
  if (units === 0) return t('llm.belowSmallest', { amount: usd(1 / TEN_THOUSANDTHS_PER_DOLLAR, 4, 4) });
  // Two to four places: the rounding happened above, in integers; this only prints it.
  return usd(units / TEN_THOUSANDTHS_PER_DOLLAR, 2, 4);
}

/**
 * A USD amount the server sent as a decimal string ("9.89709208"), in integer
 * micro-USD, rounded half up at the sixth place - parsed digit by digit, so no
 * float ever holds the money (guideline 3). Null for anything else.
 */
export function decimalUsdToMicro(text: string): number | null {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!match) return null;
  const [, sign, whole, fraction = ''] = match;
  const kept = Number((fraction + '000000').slice(0, 6));
  const roundUp = Number(fraction.charAt(6) || '0') >= 5 ? 1 : 0;
  const micro = Number(whole) * 1_000_000 + kept + roundUp;
  return sign === '-' ? -micro : micro;
}

function usd(dollars: number, minimumFractionDigits: number, maximumFractionDigits: number): string {
  return formatNumber(dollars, { style: 'currency', currency: 'USD', minimumFractionDigits, maximumFractionDigits });
}

/**
 * A purpose's cost, saying "free route" when every call went to one: there a
 * zero is the price, where for a paid model it would be a missing figure.
 */
export function purposeCost(summary: Pick<LlmPurposeSummary, 'costMicroUsd' | 'models'>): string {
  const reached = summary.models.filter((model) => model.model !== null);
  if (summary.costMicroUsd === 0 && reached.length > 0 && reached.every((model) => model.free)) {
    return t('llm.freeRoute');
  }
  return formatMicroUsd(summary.costMicroUsd);
}

/** One call's cost; a free route's zero is its price, so it says so. */
export function callCost(call: Pick<LlmCallSummary, 'costMicroUsd' | 'model'>): string {
  if (call.costMicroUsd === 0 && call.model?.endsWith(':free')) return t('llm.free');
  return formatMicroUsd(call.costMicroUsd);
}

export function formatLatency(ms: number): string {
  return ms < 1000
    ? t('llm.milliseconds', { value: formatNumber(ms) })
    : t('llm.seconds', { value: formatFixed(ms / 1000, 1) });
}
