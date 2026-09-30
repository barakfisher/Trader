/**
 * The LLM panel for the admin page: every model call the AI service recorded
 * (decision 87), per agent, and narration's fallback reasons beside them.
 *
 * Two records, deliberately both. `llm_calls` is complete but young and kept
 * for `LLM_PANEL_MAX_DAYS`; `observations.fallback_reason` is older and
 * counts explanations, not calls. Narration asks exactly once per explanation
 * it stores (`_narrate_new` drops a known finding *before* narrating it), so
 * from the first recorded call onward each fallback reason has a matching
 * count of calls, and the two are shown side by side rather than one being
 * trusted. A disagreement means a call without an explanation (the insert
 * lost a race, or the scan failed after narrating) or an explanation without a
 * call (a recording that failed, which never fails the call).
 *
 * Not measured, and said so on the page rather than shown as zero: time to
 * first token (no call streams) and a semantic-cache hit rate (there is no
 * cache).
 */

import type {
  LlmAgentSummary,
  LlmCallOutcome,
  LlmCallVerdict,
  LlmPanelResponse,
  NarrationReconciliationRow,
} from '@traders/shared';

import type { LlmCallGroupRow, LlmCallRow, LlmLatencyRow } from '../db/queries.js';

/** The AI service keeps calls this long (`LLM_CALL_RETENTION_DAYS`); a longer window would read as a quiet month. */
export const LLM_PANEL_MAX_DAYS = 30;
export const LLM_PANEL_DEFAULT_DAYS = 7;
export const LLM_PANEL_RECENT_LIMIT = 20;

/** Every agent `llm_calls` accepts, listed even when idle: "no calls" is an answer. */
const AGENTS = ['narration', 'ask'] as const;
const OUTCOMES: readonly LlmCallOutcome[] = ['ok', 'provider_error', 'budget_exhausted', 'no_provider'];
const VERDICTS: readonly LlmCallVerdict[] = [
  'accepted',
  'malformed',
  'unsourced_figures',
  'empty_completion',
  'degenerate_completion',
  'not_judged',
];

/**
 * Which calls each narration fallback reason corresponds to. Narration folds
 * an empty or looping completion into `malformed` (narrator.py), so all three
 * verdicts count against it.
 */
const NARRATION_REASONS: readonly [string, (row: LlmCallGroupRow) => boolean][] = [
  ['none', (row) => row.outcome === 'ok' && row.verdict === 'accepted'],
  ['unsourced_figures', (row) => row.verdict === 'unsourced_figures'],
  [
    'malformed',
    (row) =>
      row.verdict === 'malformed' ||
      row.verdict === 'empty_completion' ||
      row.verdict === 'degenerate_completion',
  ],
  ['provider_error', (row) => row.outcome === 'provider_error'],
  ['budget_exhausted', (row) => row.outcome === 'budget_exhausted'],
  ['no_provider', (row) => row.outcome === 'no_provider'],
];

/** OpenRouter's zero-cost route, declared by the id itself (pricing.py). */
export function isFreeRoute(model: string | null): boolean {
  return model?.endsWith(':free') ?? false;
}

/** `days` from a query string: a whole number of days within retention, or null. */
export function parseWindowDays(raw: string | undefined): number | null {
  if (raw === undefined) return LLM_PANEL_DEFAULT_DAYS;
  if (!/^\d{1,3}$/.test(raw)) return null;
  const days = Number(raw);
  return days >= 1 && days <= LLM_PANEL_MAX_DAYS ? days : null;
}

function zeroes<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
}

function verdictOf(verdict: string | null): LlmCallVerdict {
  return verdict === null ? 'not_judged' : (verdict as LlmCallVerdict);
}

function summariseAgent(
  agent: string,
  groups: LlmCallGroupRow[],
  latency: LlmLatencyRow | undefined,
): LlmAgentSummary {
  const outcomes = zeroes(OUTCOMES);
  const verdicts = zeroes(VERDICTS);
  const models = new Map<string | null, number>();
  let calls = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let costMicroUsd = 0;
  for (const row of groups) {
    calls += row.calls;
    outcomes[row.outcome as LlmCallOutcome] = (outcomes[row.outcome as LlmCallOutcome] ?? 0) + row.calls;
    // A refused call returned nothing to judge; counting it as "not judged"
    // would read as a call site that forgot its verdict.
    if (row.outcome === 'ok') verdicts[verdictOf(row.verdict)] += row.calls;
    promptTokens += Number(row.prompt_tokens);
    completionTokens += Number(row.completion_tokens);
    costMicroUsd += Number(row.cost_micro_usd);
    models.set(row.model, (models.get(row.model) ?? 0) + row.calls);
  }
  return {
    agent,
    calls,
    outcomes,
    verdicts,
    latency: latency
      ? { sample: latency.sample, p50Ms: latency.p50_ms, p95Ms: latency.p95_ms }
      : null,
    promptTokens,
    completionTokens,
    costMicroUsd,
    models: [...models]
      .map(([model, count]) => ({ model, calls: count, free: isFreeRoute(model) }))
      .sort((a, b) => b.calls - a.calls),
  };
}

function reconcileNarration(
  groups: LlmCallGroupRow[],
  explanations: { fallback_reason: string; count: number }[],
): NarrationReconciliationRow[] {
  const narration = groups.filter((row) => row.agent === 'narration');
  const stored = new Map(explanations.map((row) => [row.fallback_reason, row.count]));
  const rows: NarrationReconciliationRow[] = NARRATION_REASONS.map(([reason, matches]) => ({
    reason,
    explanations: stored.get(reason) ?? 0,
    calls: narration.filter(matches).reduce((total, row) => total + row.calls, 0),
  }));
  // A completion no verdict was given for has no reason to sit under; it is
  // still a call without a matching explanation, so it gets a row of its own.
  const unjudged = narration
    .filter((row) => row.outcome === 'ok' && row.verdict === null)
    .reduce((total, row) => total + row.calls, 0);
  if (unjudged > 0) rows.push({ reason: 'not_judged', explanations: 0, calls: unjudged });
  // A reason the observations know and this map does not must not vanish.
  for (const [reason, count] of stored) {
    if (!NARRATION_REASONS.some(([known]) => known === reason)) {
      rows.push({ reason, explanations: count, calls: 0 });
    }
  }
  return rows.filter((row) => row.explanations > 0 || row.calls > 0);
}

export interface LlmPanelInput {
  days: number;
  since: Date;
  firstCallAt: Date | null;
  groups: LlmCallGroupRow[];
  latencies: LlmLatencyRow[];
  /** Explanations over the whole window. */
  fallbacks: { fallback_reason: string; count: number }[];
  /** Explanations since the reconciliation's start (see `reconciliationSince`). */
  reconciledFallbacks: { fallback_reason: string; count: number }[];
  recent: LlmCallRow[];
}

/** Where the two records overlap: the later of the window's start and the first call. */
export function reconciliationSince(since: Date, firstCallAt: Date | null): Date | null {
  if (firstCallAt === null) return null;
  return firstCallAt > since ? firstCallAt : since;
}

export function llmPanel(input: LlmPanelInput): LlmPanelResponse {
  const agents = [...new Set([...AGENTS, ...input.groups.map((row) => row.agent)])];
  const overlap = reconciliationSince(input.since, input.firstCallAt);
  return {
    window: { days: input.days, since: input.since.toISOString() },
    firstCallAt: input.firstCallAt ? input.firstCallAt.toISOString() : null,
    agents: agents.map((agent) =>
      summariseAgent(
        agent,
        input.groups.filter((row) => row.agent === agent),
        input.latencies.find((row) => row.agent === agent),
      ),
    ),
    narrationFallbacks: input.fallbacks
      .map((row) => ({ reason: row.fallback_reason, count: row.count }))
      .sort((a, b) => b.count - a.count),
    reconciliation: overlap
      ? {
          since: overlap.toISOString(),
          rows: reconcileNarration(input.groups, input.reconciledFallbacks),
        }
      : null,
    recent: input.recent.map((row) => ({
      id: row.id,
      agent: row.agent,
      model: row.model,
      outcome: row.outcome as LlmCallOutcome,
      verdict: row.outcome === 'ok' ? verdictOf(row.verdict) : null,
      error: row.error,
      latencyMs: row.latency_ms,
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      costMicroUsd: Number(row.cost_micro_usd),
      startedAt: new Date(row.started_at).toISOString(),
    })),
  };
}
