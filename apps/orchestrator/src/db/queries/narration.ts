import { query, transaction } from '../pool.js';

/**
 * The narration provenance of the most recent scan that recorded any.
 *
 * A *scan* is the unit rather than a row or a fixed window, because the question
 * being answered is "did narration work the last time it was tried". One row is
 * too noisy - a single rejected sentence among successes is not an outage - and
 * a rolling window lags a recovery, continuing to report a fault for hours after
 * the provider came back.
 *
 * Rows written before provenance was recorded are excluded rather than counted
 * as anything: they are "not recorded", and a caller that treated them as
 * templates would invent an authorship nobody checked.
 */
export function listLatestNarrationProvenance(
  userId: string,
): Promise<{ narration_source: string; fallback_reason: string | null }[]> {
  return query(
    `-- agent-blind: narration health is the provider's, judged over every agent's findings.
     SELECT narration_source, fallback_reason
       FROM observations
      WHERE user_id = $1
        AND narration_source IS NOT NULL
        AND run_id IS NOT DISTINCT FROM (
              SELECT run_id FROM observations
               WHERE user_id = $1 AND narration_source IS NOT NULL
               ORDER BY created_at DESC
               LIMIT 1
            )`,
    [userId],
  );
}

/**
 * The provenance of the user's `limit` most recently narrated observations,
 * across scans, newest first.
 *
 * Not per scan, unlike `listLatestNarrationProvenance`: a scan usually narrates
 * one or two new findings, so one refused sentence would make a whole scan read
 * as an outage. This is what the narration notice judges by - see
 * `narrationWatch.ts`.
 */
export function listRecentNarrationProvenance(
  userId: string,
  limit: number,
): Promise<{ narration_source: string; fallback_reason: string | null }[]> {
  return query(
    `-- agent-blind: narration health is the provider's, judged over every agent's findings.
     SELECT narration_source, fallback_reason
       FROM observations
      WHERE user_id = $1 AND narration_source IS NOT NULL
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [userId, limit],
  );
}

export interface NarrationTransitionRow {
  id: string;
  from_state: string | null;
  to_state: string;
  fallback_reason: string | null;
  created_at: Date;
}

/**
 * Record narration's state if it differs from the last one recorded, and return
 * the new row - or null when nothing changed.
 *
 * The comparison and the insert run under a lock on the user's row: a portfolio
 * scan and a topic scan finishing together would otherwise both read the old
 * state and both record the change, and each row would get its own notice.
 */
export function recordNarrationState(
  userId: string,
  state: string,
  fallbackReason: string | null,
  runId: string | null,
): Promise<NarrationTransitionRow | null> {
  return transaction(async (client) => {
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const { rows } = await client.query<NarrationTransitionRow>(
      `INSERT INTO narration_transitions (user_id, from_state, to_state, fallback_reason, run_id)
       SELECT $1, latest.to_state, $2, $3, $4
         FROM (SELECT NULL) AS always
         LEFT JOIN LATERAL (
               SELECT to_state FROM narration_transitions
                WHERE user_id = $1
                ORDER BY created_at DESC, id DESC
                LIMIT 1
              ) AS latest ON true
        WHERE latest.to_state IS DISTINCT FROM $2
       RETURNING id, from_state, to_state, fallback_reason, created_at`,
      [userId, state, fallbackReason, runId],
    );
    return rows[0] ?? null;
  });
}

/** Transitions by id, for the digest: a deferred notice names what changed. */
export function listNarrationTransitions(
  userId: string,
  ids: string[],
): Promise<NarrationTransitionRow[]> {
  if (ids.length === 0) return Promise.resolve([]);
  return query<NarrationTransitionRow>(
    `SELECT id, from_state, to_state, fallback_reason, created_at
       FROM narration_transitions
      WHERE user_id = $1 AND id = ANY($2::uuid[])
      ORDER BY created_at ASC`,
    [userId, ids],
  );
}
