import type { AssetClass } from '@traders/shared';
import { query, queryOne } from '../pool.js';

export interface ObservationToStore {
  userId: string;
  runId: string | null;
  kind: string;
  severity: string;
  subjectKind: string;
  subjectRef: string;
  headline: string;
  explanation: string;
  evidence: unknown;
  conceptRefs: string[];
  dedupeKey: string;
  /**
   * Who wrote `explanation`, and why the model did not.
   *
   * The pipeline has always reported both and this insert used to drop them.
   * A reader weighs a sentence differently depending on its author, and an
   * operator asking why narration stopped needs the reason rather than the
   * logs. Null only for a caller that genuinely does not know.
   */
  narrationSource: string | null;
  fallbackReason: string | null;
}

/** An observation that was actually written, as opposed to one suppressed. */
export interface InsertedObservation {
  id: string;
  kind: string;
  severity: string;
  subject_ref: string | null;
  evidence: unknown;
  /** Carried so a notification can be rendered without re-reading the row. */
  headline: string;
  explanation: string | null;
}

/**
 * Store observations, skipping any the feed has already reported.
 *
 * `dedupe_key` is unique, so a re-scan over unchanged data inserts nothing and
 * the count of suppressed rows is the honest measure of how repetitive the scan
 * is. Suppression is silent by design at this layer and loud in the run stats:
 * nothing is lost, because an identical finding says nothing new.
 *
 * The inserted rows are returned, not just counted, because raising a proposal
 * is something that should happen for a finding the user has not seen and not
 * for one they have. Returning only a count would leave the caller to re-query
 * for "what was new", and the only honest way to answer that after the fact is
 * by timestamp - which is a race with the next scan.
 */
export async function insertObservations(
  observations: ObservationToStore[],
): Promise<{ created: number; suppressed: number; inserted: InsertedObservation[] }> {
  if (observations.length === 0) return { created: 0, suppressed: 0, inserted: [] };

  const values: string[] = [];
  const params: unknown[] = [];
  observations.forEach((observation) => {
    const base = params.length;
    params.push(
      observation.userId,
      observation.runId,
      observation.kind,
      observation.severity,
      observation.subjectKind,
      observation.subjectRef,
      observation.headline,
      observation.explanation,
      JSON.stringify(observation.evidence ?? {}),
      observation.conceptRefs,
      observation.dedupeKey,
      observation.narrationSource,
      observation.fallbackReason,
    );
    values.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, ` +
        `$${base + 7}, $${base + 8}, $${base + 9}::jsonb, $${base + 10}::text[], $${base + 11}, ` +
        `$${base + 12}, $${base + 13})`,
    );
  });

  const inserted = await query<InsertedObservation>(
    `INSERT INTO observations
       (user_id, run_id, kind, severity, subject_kind, subject_ref, headline, explanation,
        evidence, concept_refs, dedupe_key, narration_source, fallback_reason)
     VALUES ${values.join(', ')}
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id, kind, severity, subject_ref, evidence, headline, explanation`,
    params,
  );
  return {
    created: inserted.length,
    suppressed: observations.length - inserted.length,
    inserted,
  };
}

export interface ObservationRow {
  id: string;
  kind: string;
  severity: string;
  subject_kind: string;
  subject_ref: string;
  headline: string;
  explanation: string | null;
  evidence: unknown;
  concept_refs: string[];
  /** Null on rows written before provenance was recorded. Not a guess. */
  narration_source: string | null;
  fallback_reason: string | null;
  created_at: Date;
}

/**
 * Dedupe keys the feed already holds, for the scan to skip before narrating.
 *
 * Bounded by age rather than count: a key buckets by the day of the observed
 * data, so anything older than a couple of days can no longer collide with a
 * finding the next scan produces. Sending the whole history would grow the
 * request without changing a single decision.
 */
/**
 * The instruments whose price history this user's analysis reads: what they
 * hold, and what their active topics are made of.
 *
 * Topic instruments are usually *not* held - that is the point of following a
 * theme - so a backfill of holdings alone left every topic with no series, and
 * the topic scan with nothing to measure. `proposed` and `rejected` topics are
 * excluded: nobody chose their instruments.
 */
export interface AnalysedInstrumentRow {
  id: string;
  symbol: string;
  /** What prose calls it. The news matcher links by name, never by a bare ticker. */
  name: string | null;
  asset_class: AssetClass;
}

export function listAnalysedInstruments(userId: string): Promise<AnalysedInstrumentRow[]> {
  return query<AnalysedInstrumentRow>(
    `SELECT i.id, i.symbol, i.name, i.asset_class
       FROM instruments i
      WHERE i.id IN (
              SELECT h.instrument_id FROM holdings h WHERE h.user_id = $1
              UNION
              SELECT ti.instrument_id
                FROM topic_instruments ti
                JOIN topics t ON t.id = ti.topic_id
               WHERE ti.user_id = $1 AND t.status = 'active'
            )
      ORDER BY i.symbol`,
    [userId],
  );
}

export async function listRecentDedupeKeys(userId: string, days = 2): Promise<string[]> {
  const rows = await query<{ dedupe_key: string }>(
    `SELECT dedupe_key
       FROM observations
      WHERE user_id = $1
        AND created_at > now() - ($2 || ' days')::interval`,
    [userId, String(days)],
  );
  return rows.map((row) => row.dedupe_key);
}

/**
 * Severity as a rank, most severe highest - the scale of `SEVERITY_RANK` in
 * `notificationPolicy.ts`. `severity` is text, and sorts alphabetically.
 */
const SEVERITY_RANK_SQL = `CASE severity WHEN 'high' THEN 2 WHEN 'notable' THEN 1 ELSE 0 END`;

export interface ObservationFilter {
  /** Only findings about these subjects (a holding page passes `instrument:X`, `portfolio:allocation:X`). */
  subjectRefs?: string[] | null;
  /** Only findings at least this severe, on `SEVERITY_RANK`'s scale: 0 info, 1 notable, 2 high. */
  minRank?: number | null;
}

function observationWhere(filter: ObservationFilter, first: number): { sql: string; params: unknown[] } {
  return {
    sql: `AND ($${first}::text[] IS NULL OR subject_ref = ANY($${first}::text[]))
          AND (${SEVERITY_RANK_SQL}) >= coalesce($${first + 1}::int, 0)`,
    params: [filter.subjectRefs ?? null, filter.minRank ?? null],
  };
}

/**
 * The feed: newest first, and within one scan's findings the most severe first.
 *
 * Until M6 PR 11 the tie-break was `severity DESC` on the text, which put every
 * scan's high finding *last* ("notable" > "info" > "high"). A scan inserts its
 * findings with one `now()`, so ties are the normal case, not an edge.
 *
 * `before` is the id of the last finding the reader has, and the page continues
 * after it by the same ordering key - looked up from that row rather than sent
 * as a timestamp, because `created_at` carries microseconds a JavaScript `Date`
 * drops, and one scan's findings differ only there.
 */
export function listObservations(
  userId: string,
  limit = 50,
  filter: ObservationFilter = {},
  before: string | null = null,
): Promise<ObservationRow[]> {
  const where = observationWhere(filter, 4);
  return query<ObservationRow>(
    `SELECT id, kind, severity, subject_kind, subject_ref, headline, explanation,
            evidence, concept_refs, narration_source, fallback_reason, created_at
       FROM observations
      WHERE user_id = $1
        ${where.sql}
        AND ($3::uuid IS NULL OR (created_at, ${SEVERITY_RANK_SQL}, id) < (
              SELECT a.created_at,
                     CASE a.severity WHEN 'high' THEN 2 WHEN 'notable' THEN 1 ELSE 0 END,
                     a.id
                FROM observations a
               WHERE a.id = $3 AND a.user_id = $1))
      ORDER BY created_at DESC, ${SEVERITY_RANK_SQL} DESC, id DESC
      LIMIT $2`,
    [userId, limit, before, ...where.params],
  );
}

/** How many findings the filter matches in all, so a page can say it is one. */
export async function countObservations(userId: string, filter: ObservationFilter = {}): Promise<number> {
  const where = observationWhere(filter, 2);
  const row = await queryOne<{ count: string }>(
    `SELECT count(*)::text AS count FROM observations WHERE user_id = $1 ${where.sql}`,
    [userId, ...where.params],
  );
  return Number(row?.count ?? 0);
}
