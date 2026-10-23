import { query, queryOne } from '../pool.js';

/**
 * Model calls since `since`, counted per purpose, model, outcome and verdict.
 * Sums arrive as text: `bigint` is how Postgres sums, and a string is how `pg`
 * returns one rather than rounding it.
 */
export interface LlmCallGroupRow {
  purpose: string;
  model: string | null;
  outcome: string;
  verdict: string | null;
  calls: number;
  prompt_tokens: string;
  completion_tokens: string;
  cost_micro_usd: string;
}

export function groupLlmCalls(since: Date): Promise<LlmCallGroupRow[]> {
  return query<LlmCallGroupRow>(
    `SELECT purpose, model, outcome, verdict, count(*)::int AS calls,
            sum(prompt_tokens)::text AS prompt_tokens,
            sum(completion_tokens)::text AS completion_tokens,
            sum(cost_micro_usd)::text AS cost_micro_usd
       FROM llm_calls
      WHERE started_at >= $1
      GROUP BY purpose, model, outcome, verdict`,
    [since],
  );
}

export interface LlmLatencyRow {
  purpose: string;
  sample: number;
  p50_ms: number;
  p95_ms: number;
}

/**
 * Latency per purpose over the calls that reached a provider. A call refused for
 * want of a provider or of budget took no time worth measuring, and averaging
 * its zero in would flatter the model. `percentile_disc` answers with a latency
 * that was actually observed, not one interpolated between two.
 */
export function llmLatencies(since: Date): Promise<LlmLatencyRow[]> {
  return query<LlmLatencyRow>(
    `SELECT purpose, count(*)::int AS sample,
            percentile_disc(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50_ms,
            percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_ms
       FROM llm_calls
      WHERE started_at >= $1 AND outcome IN ('ok', 'provider_error')
      GROUP BY purpose`,
    [since],
  );
}

/** When the oldest call still held was made; null when none is. */
export async function firstLlmCallAt(): Promise<Date | null> {
  const row = await queryOne<{ first: Date | null }>(`SELECT min(started_at) AS first FROM llm_calls`);
  return row?.first ?? null;
}

export interface LlmCallRow {
  id: string;
  purpose: string;
  model: string | null;
  outcome: string;
  verdict: string | null;
  error: string | null;
  latency_ms: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost_micro_usd: string;
  started_at: Date;
}

/**
 * The latest calls, without their prompt or completion: both hold portfolio
 * data, and an operator diagnosing a provider needs the outcome, not the text.
 */
export function listLlmCalls(limit: number): Promise<LlmCallRow[]> {
  return query<LlmCallRow>(
    `SELECT id::text, purpose, model, outcome, verdict, left(error, 300) AS error, latency_ms,
            prompt_tokens, completion_tokens, cost_micro_usd::text, started_at
       FROM llm_calls
      ORDER BY started_at DESC, id DESC
      LIMIT $1`,
    [limit],
  );
}

/**
 * Stored explanations since `since`, counted by why a model did not write
 * them (`none`: it did). Every account's, like the rest of the admin surface;
 * rows from before the column existed carry no provenance and are left out.
 */
export function countNarrationFallbacks(
  since: Date,
): Promise<{ fallback_reason: string; count: number }[]> {
  return query(
    `-- agent-blind: the admin panel counts every account's and every agent's explanations.
     SELECT fallback_reason, count(*)::int AS count
       FROM observations
      WHERE created_at >= $1 AND narration_source IS NOT NULL AND fallback_reason IS NOT NULL
      GROUP BY fallback_reason`,
    [since],
  );
}

/** A user's own-key month (D209, D250): what this app spent on their key, their limit, the reset. */
export interface MonthlySpendRow {
  /** Calls made on the user's own OpenRouter key, as estimated here. */
  own_key_spent_micro_usd: string;
  /** The user's monthly safety limit, or null when none is set. */
  safety_limit_micro_usd: string | null;
  /** `YYYY-MM-DD`: the first day of the user's next calendar month, in their zone. */
  resets_on: string;
}

/**
 * The user's own-key spend this month against their safety limit, or null for
 * the admin, who runs on the installation's key (D245). The same month the AI
 * service enforces (`app/llm/monthly_cap.py`): the calendar month in
 * `users.timezone`, summed over every recorded call made on the user's own key.
 */
export function getMonthlySpend(userId: string): Promise<MonthlySpendRow | null> {
  return queryOne<MonthlySpendRow>(
    `WITH month AS (
       SELECT u.id, u.timezone, s.llm_safety_limit_micro_usd AS safety_limit,
              date_trunc('month', now() AT TIME ZONE u.timezone) AS local_start
         FROM users u
         LEFT JOIN user_settings s ON s.user_id = u.id
        WHERE u.id = $1 AND u.role <> 'admin'
     )
     SELECT coalesce(sp.own_key, 0)::text AS own_key_spent_micro_usd,
            m.safety_limit::text AS safety_limit_micro_usd,
            to_char(m.local_start + interval '1 month', 'YYYY-MM-DD') AS resets_on
       FROM month m
       CROSS JOIN LATERAL (
         SELECT sum(c.cost_micro_usd) AS own_key
           FROM llm_calls c
          WHERE c.user_id = m.id AND c.paid_by = 'own_key'
            AND c.started_at >= (m.local_start AT TIME ZONE m.timezone)
       ) sp`,
    [userId],
  );
}
