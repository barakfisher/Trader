/**
 * Whether explanations are being written by a model, and if not, why not.
 *
 * Two halves. *How narration is configured* belongs to the AI service, which
 * owns the LLM, and is asked of it rather than copied into this process's
 * environment. *What actually happened* belongs to the feed, where every
 * observation now records its own provenance.
 *
 * The states are the ones an operator would act on differently, and they are
 * deliberately not collapsed. A spent budget is fixed by paying; a rate limit
 * is fixed by waiting or leaving a shared pool; sentences the evidence
 * validator refuses are fixed only by a more capable model, and no amount of
 * waiting or paying a smaller one will help. A single "degraded" would send
 * someone to the wrong remedy, and a single "exhausted" would be wrong outright:
 * the free tier here answers every request and still narrates nothing.
 */

import type { NarrationConfig } from '@traders/shared/ai';

/** Why narration is in the state it is in, in the words the UI uses. */
export type NarrationState =
  /** No provider was asked for. A configuration, not a failure. */
  | 'off'
  /** The model is writing the explanations. */
  | 'narrating'
  /** The provider refused - a shared free pool, or an outage. Waiting may fix it. */
  | 'unavailable'
  /** The spend ceiling stopped the calls. Paying fixes it; waiting does not. */
  | 'exhausted'
  /** The model answers, and the evidence validator refuses its figures. */
  | 'rejected'
  /** Nothing has been recorded yet. Not a claim in either direction. */
  | 'unknown';

export interface NarrationHealth {
  state: NarrationState;
  /** `free` bills nothing and is a shared pool; `paid` bills per token. */
  tier: NarrationConfig['tier'];
  model: string | null;
  /** How many explanations the state was read from. Zero means `unknown`. */
  sampleSize: number;
  /** The raw reason behind `rejected`/`unavailable`, for an operator, not a reader. */
  lastFallbackReason: string | null;
}

/**
 * Map one scan's provenance onto a state.
 *
 * **Any model-written sentence means narration works.** A scan where four
 * findings were narrated and one was rejected is a working narrator meeting one
 * awkward finding, not an outage - reporting it as a fault would cry wolf on
 * every scan, and an indicator nobody believes is worse than none.
 */
export function narrationStateFrom(
  rows: { narration_source: string; fallback_reason: string | null }[],
  tier: NarrationConfig['tier'],
): { state: NarrationState; lastFallbackReason: string | null } {
  if (tier === 'none') return { state: 'off', lastFallbackReason: null };
  if (rows.length === 0) return { state: 'unknown', lastFallbackReason: null };
  if (rows.some((row) => row.narration_source === 'llm')) {
    return { state: 'narrating', lastFallbackReason: null };
  }

  // Every sentence in the scan was a template. The reason they all share is the
  // one worth reporting; where they differ, the most serious wins, because the
  // cheapest remedy that could possibly work is the one to show first.
  const reasons = rows.map((row) => row.fallback_reason).filter((r): r is string => r !== null);
  const worst = PRECEDENCE.find((reason) => reasons.includes(reason)) ?? reasons[0] ?? null;
  return { state: worst === null ? 'unknown' : (STATE_BY_REASON[worst] ?? 'unavailable'), lastFallbackReason: worst };
}

/**
 * Most serious first. `no_provider` outranks the rest because it means nothing
 * was even attempted, and `budget_exhausted` outranks a transport failure
 * because it will not clear by itself.
 */
const PRECEDENCE = [
  'no_provider',
  'budget_exhausted',
  'unsourced_figures',
  'malformed',
  'provider_error',
] as const;

const STATE_BY_REASON: Record<string, NarrationState> = {
  none: 'narrating',
  no_provider: 'off',
  budget_exhausted: 'exhausted',
  provider_error: 'unavailable',
  // Both mean the same thing to a reader: the model answered and its answer was
  // not usable. They differ only in which check caught it.
  unsourced_figures: 'rejected',
  malformed: 'rejected',
};
