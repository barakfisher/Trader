/**
 * How model calls read on the admin page. Kept apart from the component so
 * the wording and the arithmetic can be tested.
 */

import type {
  LlmAgentSummary,
  LlmCallOutcome,
  LlmCallSummary,
  LlmCallVerdict,
} from '@traders/shared';

/** The windows the card offers; the server accepts any whole number up to its retention. */
export const LLM_WINDOWS = [1, 7, 30] as const;

export const OUTCOME_LABEL: Record<LlmCallOutcome, string> = {
  ok: 'answered',
  provider_error: 'provider error',
  budget_exhausted: 'daily budget spent',
  no_provider: 'no model configured',
};

export const VERDICT_LABEL: Record<LlmCallVerdict, string> = {
  accepted: 'accepted',
  malformed: 'malformed',
  unsourced_figures: 'unsourced figures',
  empty_completion: 'empty',
  degenerate_completion: 'looping',
  not_judged: 'no verdict given',
};

/** An `observations.fallback_reason`, as an operator would say it. */
const REASON_LABEL: Record<string, string> = {
  none: 'written by the model',
  unsourced_figures: 'refused: figures not in the evidence',
  malformed: 'refused: unusable reply',
  provider_error: 'provider error',
  budget_exhausted: 'daily budget spent',
  no_provider: 'no model configured',
  not_judged: 'no verdict given',
};

export function reasonLabel(reason: string): string {
  return REASON_LABEL[reason] ?? reason;
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
  if (micro === 0) return '$0';
  const units = Math.round(micro / MICRO_PER_TEN_THOUSANDTH);
  if (units === 0) return '<$0.0001';
  const dollars = Math.floor(units / TEN_THOUSANDTHS_PER_DOLLAR);
  const fraction = String(units % TEN_THOUSANDTHS_PER_DOLLAR).padStart(4, '0').replace(/0{1,2}$/, '');
  return `$${dollars.toLocaleString('en-US')}.${fraction}`;
}

/**
 * An agent's cost, saying "free route" when every call went to one: there a
 * zero is the price, where for a paid model it would be a missing figure.
 */
export function agentCost(agent: Pick<LlmAgentSummary, 'costMicroUsd' | 'models'>): string {
  const reached = agent.models.filter((model) => model.model !== null);
  if (agent.costMicroUsd === 0 && reached.length > 0 && reached.every((model) => model.free)) {
    return 'free route';
  }
  return formatMicroUsd(agent.costMicroUsd);
}

/** One call's cost; a free route's zero is its price, so it says so. */
export function callCost(call: Pick<LlmCallSummary, 'costMicroUsd' | 'model'>): string {
  if (call.costMicroUsd === 0 && call.model?.endsWith(':free')) return 'free';
  return formatMicroUsd(call.costMicroUsd);
}

export function formatLatency(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}
