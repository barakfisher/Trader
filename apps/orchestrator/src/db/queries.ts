/**
 * Every SQL statement in the orchestrator. Keeping them together makes the data
 * access surface auditable and keeps SQL out of the HTTP layer.
 */

import type { PoolClient } from 'pg';
import type { AssetClass, ProposalBand, TopicEvidence } from '@traders/shared';

export type { TopicEvidence };

import { logger } from '../logger.js';
import { query, queryOne, transaction } from './pool.js';

export interface UserRow {
  id: string;
  email: string | null;
  base_currency: string;
  timezone: string;
}

export interface InstrumentRow {
  id: string;
  symbol: string;
  name: string | null;
  asset_class: AssetClass;
  exchange: string | null;
  currency: string;
}

export interface HoldingRow {
  id: string;
  user_id: string;
  instrument_id: string;
  quantity: string;
  cost_basis_minor: string | null;
  currency: string;
  opened_at: Date | null;
  notes: string | null;
  symbol: string;
  name: string | null;
  asset_class: AssetClass;
  exchange: string | null;
  instrument_currency: string;
}

export interface RunRow {
  id: string;
  kind: string;
  run_key: string;
  status: string;
  started_at: Date;
  finished_at: Date | null;
}

export interface SnapshotRow {
  /**
   * The calendar date as Postgres stores it, YYYY-MM-DD. Selected as text on
   * purpose: node-postgres turns a DATE into a JS Date at *local* midnight, and
   * formatting that with toISOString() gave the previous day on any server east
   * of UTC - the equity curve was a day early on this machine (UTC+3) and right
   * in the container (UTC), so nothing in CI could see it.
   */
  as_of: string;
  total_minor: string;
  cost_minor: string;
  currency: string;
  holdings_count: number;
  priced_count: number;
  degraded: boolean;
}

export function getUser(userId: string): Promise<UserRow | null> {
  return queryOne<UserRow>('SELECT id, email, base_currency, timezone FROM users WHERE id = $1', [
    userId,
  ]);
}

export interface UpsertInstrumentInput {
  symbol: string;
  name?: string | null;
  assetClass?: AssetClass;
  exchange?: string | null;
  currency?: string;
}

/**
 * Insert the instrument or return the existing row. Name, exchange and currency
 * are refreshed from the provider only when we previously had nothing, so a
 * manual correction is never silently overwritten by a provider guess.
 */
export function upsertInstrument(
  input: UpsertInstrumentInput,
  client?: PoolClient,
): Promise<InstrumentRow> {
  const sql = `
    INSERT INTO instruments (symbol, name, asset_class, exchange, currency)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (symbol) DO UPDATE SET
      name        = COALESCE(instruments.name, EXCLUDED.name),
      exchange    = COALESCE(instruments.exchange, EXCLUDED.exchange),
      asset_class = CASE WHEN instruments.asset_class = 'unknown'
                         THEN EXCLUDED.asset_class ELSE instruments.asset_class END
    RETURNING id, symbol, name, asset_class, exchange, currency
  `;
  const params = [
    input.symbol.toUpperCase(),
    input.name ?? null,
    input.assetClass ?? 'unknown',
    input.exchange ?? null,
    (input.currency ?? 'USD').toUpperCase(),
  ];
  if (client) return client.query<InstrumentRow>(sql, params).then((r) => r.rows[0]!);
  return queryOne<InstrumentRow>(sql, params).then((row) => {
    if (!row) throw new Error(`failed to upsert instrument ${input.symbol}`);
    return row;
  });
}

export function listHoldings(userId: string): Promise<HoldingRow[]> {
  return query<HoldingRow>(
    `SELECT h.id, h.user_id, h.instrument_id, h.quantity::text AS quantity,
            h.cost_basis_minor::text AS cost_basis_minor, h.currency, h.opened_at, h.notes,
            i.symbol, i.name, i.asset_class, i.exchange, i.currency AS instrument_currency
       FROM holdings h
       JOIN instruments i ON i.id = h.instrument_id
      WHERE h.user_id = $1
      ORDER BY i.symbol`,
    [userId],
  );
}

export function getHolding(userId: string, holdingId: string): Promise<HoldingRow | null> {
  return queryOne<HoldingRow>(
    `SELECT h.id, h.user_id, h.instrument_id, h.quantity::text AS quantity,
            h.cost_basis_minor::text AS cost_basis_minor, h.currency, h.opened_at, h.notes,
            i.symbol, i.name, i.asset_class, i.exchange, i.currency AS instrument_currency
       FROM holdings h
       JOIN instruments i ON i.id = h.instrument_id
      WHERE h.user_id = $1 AND h.id = $2`,
    [userId, holdingId],
  );
}

export interface UpsertHoldingInput {
  userId: string;
  instrumentId: string;
  quantity: string;
  costBasisMinor: number | null;
  currency: string;
  openedAt: string | null;
  notes: string | null;
}

/**
 * Merge semantics (FLOWS.md F1): one row per instrument per user. Re-importing
 * the same instrument updates quantity and cost basis instead of duplicating.
 */
export function upsertHolding(
  input: UpsertHoldingInput,
  client?: PoolClient,
): Promise<{ id: string; inserted: boolean }> {
  const sql = `
    INSERT INTO holdings (user_id, instrument_id, quantity, cost_basis_minor, currency, opened_at, notes)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (user_id, instrument_id) DO UPDATE SET
      quantity         = EXCLUDED.quantity,
      cost_basis_minor = COALESCE(EXCLUDED.cost_basis_minor, holdings.cost_basis_minor),
      currency         = EXCLUDED.currency,
      opened_at        = COALESCE(EXCLUDED.opened_at, holdings.opened_at),
      notes            = COALESCE(EXCLUDED.notes, holdings.notes),
      updated_at       = now()
    RETURNING id, (xmax = 0) AS inserted
  `;
  const params = [
    input.userId,
    input.instrumentId,
    input.quantity,
    input.costBasisMinor,
    input.currency.toUpperCase(),
    input.openedAt,
    input.notes,
  ];
  if (client) {
    return client.query<{ id: string; inserted: boolean }>(sql, params).then((r) => r.rows[0]!);
  }
  return queryOne<{ id: string; inserted: boolean }>(sql, params).then((row) => {
    if (!row) throw new Error('failed to upsert holding');
    return row;
  });
}

export interface UpdateHoldingPatch {
  quantity?: string;
  costBasisMinor?: number | null;
  currency?: string;
  openedAt?: string | null;
  notes?: string | null;
}

export async function updateHolding(
  userId: string,
  holdingId: string,
  patch: UpdateHoldingPatch,
): Promise<HoldingRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [userId, holdingId];
  const push = (fragment: string, value: unknown) => {
    params.push(value);
    sets.push(`${fragment} = $${params.length}`);
  };
  if (patch.quantity !== undefined) push('quantity', patch.quantity);
  if (patch.costBasisMinor !== undefined) push('cost_basis_minor', patch.costBasisMinor);
  if (patch.currency !== undefined) push('currency', patch.currency.toUpperCase());
  if (patch.openedAt !== undefined) push('opened_at', patch.openedAt);
  if (patch.notes !== undefined) push('notes', patch.notes);
  if (sets.length === 0) return getHolding(userId, holdingId);

  const updated = await queryOne<{ id: string }>(
    `UPDATE holdings SET ${sets.join(', ')}, updated_at = now()
      WHERE user_id = $1 AND id = $2 RETURNING id`,
    params,
  );
  return updated ? getHolding(userId, holdingId) : null;
}

export async function deleteHolding(userId: string, holdingId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    'DELETE FROM holdings WHERE user_id = $1 AND id = $2 RETURNING id',
    [userId, holdingId],
  );
  return rows.length > 0;
}

export async function deleteAllHoldings(userId: string, client?: PoolClient): Promise<number> {
  const sql = 'DELETE FROM holdings WHERE user_id = $1';
  if (client) {
    const result = await client.query(sql, [userId]);
    return result.rowCount ?? 0;
  }
  const rows = await query<{ id: string }>(`${sql} RETURNING id`, [userId]);
  return rows.length;
}

// --- Target weights -----------------------------------------------------------

export interface TargetWeightRow {
  instrument_id: string;
  symbol: string;
  name: string | null;
  /** `numeric(6, 4)` read as text: a weight never passes through a float. */
  weight: string;
}

export interface TargetWeightInput {
  instrumentId: string;
  weight: string;
}

export function listTargetWeights(userId: string): Promise<TargetWeightRow[]> {
  return query<TargetWeightRow>(
    `SELECT t.instrument_id, t.weight::text AS weight, i.symbol, i.name
       FROM target_weights t
       JOIN instruments i ON i.id = t.instrument_id
      WHERE t.user_id = $1
      ORDER BY i.symbol`,
    [userId],
  );
}

/** Look up instruments by symbol, so a write can reject names we have never resolved. */
export function findInstrumentsBySymbols(symbols: string[]): Promise<InstrumentRow[]> {
  if (symbols.length === 0) return Promise.resolve([]);
  return query<InstrumentRow>(
    `SELECT id, symbol, name, asset_class, exchange, currency
       FROM instruments
      WHERE symbol = ANY($1::text[])`,
    [symbols.map((symbol) => symbol.toUpperCase())],
  );
}

/**
 * Instruments that carry no display name, oldest first.
 *
 * `instruments` has no `user_id` - it is reference data shared by every account
 * - so this is deliberately not scoped to one user. A name is a fact about the
 * symbol, not about who holds it.
 */
export function listInstrumentsWithoutName(limit = 200): Promise<{ id: string; symbol: string }[]> {
  return query<{ id: string; symbol: string }>(
    `SELECT id, symbol
       FROM instruments
      WHERE name IS NULL
      ORDER BY symbol
      LIMIT $1`,
    [limit],
  );
}

/**
 * Fill in an instrument's display name, once.
 *
 * `WHERE name IS NULL` rather than an unconditional SET, for the same reason
 * `upsertInstrument` coalesces: a name a user or a better provider has already
 * supplied must not be replaced by a later provider's guess. Returns whether a
 * row was actually written, so the run can report what it changed.
 */
export async function setInstrumentName(instrumentId: string, name: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE instruments
        SET name = $2
      WHERE id = $1 AND name IS NULL
      RETURNING id`,
    [instrumentId, name],
  );
  return rows.length > 0;
}

/**
 * Replace the user's entire set of target weights in one transaction.
 *
 * Replace, not patch: a set of weights is a single statement about how the
 * portfolio was meant to be shaped, and the constraint that matters (they sum to
 * at most the whole portfolio) is a property of the set, not of any one row. A
 * partial update can therefore leave behind a combination the user never chose,
 * and the drift rule would then report against it as if they had.
 *
 * An empty set is a legitimate input: it clears the targets, and the scan goes
 * back to reporting that drift has nothing to compare against.
 */
export async function replaceTargetWeights(
  userId: string,
  targets: TargetWeightInput[],
): Promise<number> {
  return transaction(async (client) => {
    await client.query('DELETE FROM target_weights WHERE user_id = $1', [userId]);
    if (targets.length === 0) return 0;

    const values: string[] = [];
    const params: unknown[] = [userId];
    targets.forEach((target) => {
      params.push(target.instrumentId, target.weight);
      values.push(`($1, $${params.length - 1}, $${params.length}::numeric)`);
    });
    await client.query(
      `INSERT INTO target_weights (user_id, instrument_id, weight) VALUES ${values.join(', ')}`,
      params,
    );
    return targets.length;
  });
}

export interface QuoteToStore {
  instrumentId: string;
  asOf: string;
  priceMinor: number;
  currency: string;
  source: string;
  delaySeconds: number;
}

/** Append quotes to the time series. Re-recording the same instant is a no-op. */
export async function recordQuotes(quotes: QuoteToStore[]): Promise<void> {
  if (quotes.length === 0) return;
  const values: string[] = [];
  const params: unknown[] = [];
  quotes.forEach((quote) => {
    const base = params.length;
    params.push(
      quote.instrumentId,
      quote.asOf,
      quote.priceMinor,
      quote.currency,
      quote.source,
      quote.delaySeconds,
    );
    values.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`,
    );
  });
  await query(
    `INSERT INTO quotes (instrument_id, as_of, price_minor, currency, source, delay_seconds)
     VALUES ${values.join(', ')}
     ON CONFLICT (instrument_id, as_of) DO NOTHING`,
    params,
  );
}

export interface SnapshotInput {
  userId: string;
  asOf: string;
  totalMinor: number;
  costMinor: number;
  currency: string;
  breakdown: unknown;
  holdingsCount: number;
  pricedCount: number;
  degraded: boolean;
}

/** One snapshot per user per day; re-running the job overwrites today's row. */
export async function upsertSnapshot(input: SnapshotInput): Promise<void> {
  await query(
    `INSERT INTO portfolio_snapshots
       (user_id, as_of, total_minor, cost_minor, currency, breakdown,
        holdings_count, priced_count, degraded)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
     ON CONFLICT (user_id, as_of) DO UPDATE SET
       total_minor    = EXCLUDED.total_minor,
       cost_minor     = EXCLUDED.cost_minor,
       currency       = EXCLUDED.currency,
       breakdown      = EXCLUDED.breakdown,
       holdings_count = EXCLUDED.holdings_count,
       priced_count   = EXCLUDED.priced_count,
       -- Overwritten, not OR-ed: a re-run that prices everything supersedes the
       -- earlier partial attempt for the same day, which is the point of
       -- re-running the job.
       degraded       = EXCLUDED.degraded`,
    [
      input.userId,
      input.asOf,
      input.totalMinor,
      input.costMinor,
      input.currency,
      JSON.stringify(input.breakdown),
      input.holdingsCount,
      input.pricedCount,
      input.degraded,
    ],
  );
}

export function listSnapshots(userId: string, limit = 365): Promise<SnapshotRow[]> {
  return query<SnapshotRow>(
    `SELECT as_of::text AS as_of, total_minor::text AS total_minor, cost_minor::text AS cost_minor, currency,
            holdings_count, priced_count, degraded
       FROM portfolio_snapshots
      WHERE user_id = $1
      ORDER BY as_of DESC
      LIMIT $2`,
    [userId, limit],
  );
}

// --- Runs: idempotency that survives a restart --------------------------------

/**
 * How long a run may sit in `running` before another trigger may take it over.
 *
 * Without this, a process killed mid-run leaves its key claimed forever and that
 * work never happens again - for a daily key, that is a day permanently skipped.
 * The window has to exceed the longest plausible run and stay well under the
 * shortest gap between triggers.
 */
const STALE_RUN_MINUTES = 30;

export interface ClaimRunInput {
  userId: string;
  kind: string;
  runKey: string;
  trigger: string;
}

/**
 * Claim a run, or report that someone already has it.
 *
 * The claim is the INSERT itself: `run_key` is unique, so exactly one caller can
 * succeed no matter how many fire at once, across processes and replicas. A
 * previous attempt that died mid-flight is reclaimed after STALE_RUN_MINUTES;
 * anything else already claimed returns `claimed: false` and the caller stops.
 */
export async function claimRun(
  input: ClaimRunInput,
): Promise<{ claimed: boolean; runId: string | null; existingStatus?: string }> {
  const inserted = await queryOne<{ id: string }>(
    `INSERT INTO runs (user_id, kind, run_key, trigger, status)
     VALUES ($1, $2, $3, $4, 'running')
     ON CONFLICT (run_key) DO NOTHING
     RETURNING id`,
    [input.userId, input.kind, input.runKey, input.trigger],
  );
  if (inserted) return { claimed: true, runId: inserted.id };

  const reclaimed = await queryOne<{ id: string }>(
    `UPDATE runs
        SET status = 'running', started_at = now(), finished_at = NULL, trigger = $2
      WHERE run_key = $1
        AND status = 'running'
        AND started_at < now() - ($3 || ' minutes')::interval
      RETURNING id`,
    [input.runKey, input.trigger, String(STALE_RUN_MINUTES)],
  );
  if (reclaimed) {
    logger().warn({ runKey: input.runKey }, 'reclaimed a run left running by a dead process');
    return { claimed: true, runId: reclaimed.id };
  }

  const existing = await queryOne<{ status: string }>(
    'SELECT status FROM runs WHERE run_key = $1',
    [input.runKey],
  );
  return { claimed: false, runId: null, existingStatus: existing?.status };
}

export async function finishRun(
  runId: string,
  status: 'ok' | 'degraded' | 'failed' | 'skipped',
  stats: unknown = {},
): Promise<void> {
  await query(`UPDATE runs SET status = $2, finished_at = now(), stats = $3::jsonb WHERE id = $1`, [
    runId,
    status,
    JSON.stringify(stats),
  ]);
}

/** Most recent runs, newest first. Backs the "did anything run today?" check. */
export function listRuns(userId: string, kind?: string, limit = 50): Promise<RunRow[]> {
  return query<RunRow>(
    `SELECT id, kind, run_key, status, started_at, finished_at
       FROM runs
      WHERE user_id = $1 AND ($2::text IS NULL OR kind = $2)
      ORDER BY started_at DESC
      LIMIT $3`,
    [userId, kind ?? null, limit],
  );
}

/**
 * The last finished run of `kind`, with what it recorded.
 *
 * The digest reads a topic scan's `stats.skipped` from here: that map is the only
 * record of which topics a scan could not measure, and "not measured" must not
 * be reported as "nothing moved".
 */
export function getLatestFinishedRun(
  userId: string,
  kind: string,
): Promise<{ started_at: Date; status: string; stats: unknown } | null> {
  return queryOne(
    `SELECT started_at, status, stats
       FROM runs
      WHERE user_id = $1 AND kind = $2 AND finished_at IS NOT NULL
      ORDER BY started_at DESC
      LIMIT 1`,
    [userId, kind],
  );
}

// --- Observations -------------------------------------------------------------

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
    `SELECT narration_source, fallback_reason
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
    `SELECT narration_source, fallback_reason
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
 * The feed, newest first. `subjectRefs`, when given, keeps only findings about
 * those subjects - a holding page passes the refs its symbol can appear under
 * (`instrument:NVDA`, `portfolio:allocation:NVDA`).
 */
export function listObservations(
  userId: string,
  limit = 50,
  subjectRefs: string[] | null = null,
): Promise<ObservationRow[]> {
  return query<ObservationRow>(
    `SELECT id, kind, severity, subject_kind, subject_ref, headline, explanation,
            evidence, concept_refs, narration_source, fallback_reason, created_at
       FROM observations
      WHERE user_id = $1
        AND ($3::text[] IS NULL OR subject_ref = ANY($3::text[]))
      ORDER BY created_at DESC, severity DESC
      LIMIT $2`,
    [userId, limit, subjectRefs],
  );
}

// --- Proposals, their audit trail, and the paper ledger -------------------------

export interface ProposalRow {
  id: string;
  user_id: string;
  observation_id: string;
  kind: string;
  payload: unknown;
  state: string;
  expires_at: Date;
  snoozed_until: Date | null;
  decided_at: Date | null;
  decided_via: string | null;
  created_at: Date;
  /** Joined from the observation, so the inbox renders without a second query. */
  severity: string;
  subject_ref: string | null;
  headline: string;
  explanation: string | null;
  evidence: unknown;
}

export interface ProposalToCreate {
  userId: string;
  observationId: string;
  kind: string;
  payload: unknown;
  expiresAt: Date;
}

/**
 * Raise proposals for findings that do not already have one.
 *
 * `ON CONFLICT (observation_id) DO NOTHING` is what makes a re-scan cheap: the
 * observation layer already suppresses a repeated finding by `dedupe_key`, and
 * this is the same guarantee one level up, for the case where an observation
 * survives but its proposal was created by an earlier run. Two suppression
 * schemes would eventually disagree; this one defers to the first.
 *
 * The ids are returned rather than counted because a raised proposal is now the
 * start of something - a workflow run waits on it - and a caller that only
 * learns *how many* were raised cannot address any of them.
 */
export async function createProposals(proposals: ProposalToCreate[]): Promise<string[]> {
  if (proposals.length === 0) return [];

  const values: string[] = [];
  const params: unknown[] = [];
  proposals.forEach((proposal) => {
    const base = params.length;
    params.push(
      proposal.userId,
      proposal.observationId,
      proposal.kind,
      JSON.stringify(proposal.payload ?? {}),
      proposal.expiresAt,
    );
    values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::jsonb, $${base + 5})`);
  });

  const inserted = await query<{ id: string }>(
    `INSERT INTO proposals (user_id, observation_id, kind, payload, expires_at)
     VALUES ${values.join(', ')}
     ON CONFLICT (observation_id) DO NOTHING
     RETURNING id`,
    params,
  );
  return inserted.map((row) => row.id);
}

/** The columns every proposal read returns, joined to the finding behind it. */
const PROPOSAL_COLUMNS = `p.id, p.user_id, p.observation_id, p.kind, p.payload, p.state,
       p.expires_at, p.snoozed_until, p.decided_at, p.decided_via, p.created_at,
       o.severity, o.subject_ref, o.headline, o.explanation, o.evidence`;

export function findProposal(userId: string, proposalId: string): Promise<ProposalRow | null> {
  return queryOne<ProposalRow>(
    `SELECT ${PROPOSAL_COLUMNS}
       FROM proposals p
       JOIN observations o ON o.id = p.observation_id
      WHERE p.user_id = $1 AND p.id = $2`,
    [userId, proposalId],
  );
}

/**
 * The inbox. Ordered by deadline rather than by creation: what matters about an
 * open question is how long is left to answer it, and a proposal raised an hour
 * ago with a two-hour TTL is more urgent than one raised yesterday with a week.
 *
 * `open` selects on the *stored* state, and the caller re-reads each row through
 * `effectiveState` - so a proposal whose deadline passed since the last sweep
 * arrives here and is rendered as expired rather than being invisible until the
 * sweep catches up. Filtering on the computed state in SQL would duplicate the
 * state machine in a second language.
 */
export function listProposals(
  userId: string,
  options: { open?: boolean; approved?: boolean; decided?: boolean; limit?: number } = {},
): Promise<ProposalRow[]> {
  const { open = false, approved = false, decided = false, limit = 50 } = options;
  // Approvals are listed newest decision first - they are what the web inbox
  // offers Undo on, and the one just made is the one most likely to be undone.
  // Approved is terminal, so the stored state is the effective one and no
  // deadline re-check is needed.
  // `decided` is the inbox's history: every terminal state, including the ones
  // nobody chose - an expiry is an outcome the user should be able to find.
  const filter = open
    ? `AND p.state IN ('pending','snoozed')`
    : approved
      ? `AND p.state = 'approved'`
      : decided
        ? `AND p.state IN ('approved','rejected','expired')`
        : '';
  const order = approved || decided
    ? 'p.decided_at DESC NULLS LAST, p.created_at DESC'
    : 'p.expires_at ASC, p.created_at DESC';
  return query<ProposalRow>(
    `SELECT ${PROPOSAL_COLUMNS}
       FROM proposals p
       JOIN observations o ON o.id = p.observation_id
      WHERE p.user_id = $1
        ${filter}
      ORDER BY ${order}
      LIMIT $2`,
    [userId, limit],
  );
}

/** Proposals whose deadline has passed but whose row has not caught up yet. */
export function listProposalsToExpire(limit = 500): Promise<ProposalRow[]> {
  return query<ProposalRow>(
    `SELECT ${PROPOSAL_COLUMNS}
       FROM proposals p
       JOIN observations o ON o.id = p.observation_id
      WHERE p.state IN ('pending','snoozed')
        AND p.expires_at <= now()
      ORDER BY p.expires_at ASC
      LIMIT $1`,
    [limit],
  );
}

export interface TransitionToApply {
  proposalId: string;
  userId: string;
  fromState: string;
  toState: string;
  surface: string;
  /** Null for a system transition: nobody did it, and that is not a user id. */
  actorUserId: string | null;
  snoozedUntil: Date | null;
  evidenceSnapshot: unknown;
  /** A Telegram callback nonce. Unique where present, so a replay cannot repeat. */
  idempotencyKey: string | null;
  /** The ledger row an approval writes. Null for every other transition. */
  intent: { kind: string; payload: unknown } | null;
  /** True when this transition leaves `approved`: the live ledger row is revoked. */
  revokeIntent: boolean;
}

export interface TransitionResult {
  /** False when another writer got there first; the caller re-reads and reports. */
  applied: boolean;
  intentId: string | null;
}

/**
 * Apply one transition: the row, its audit entry and - for an approval - the
 * ledger, in a single transaction.
 *
 * The UPDATE carries `AND state = $fromState` because the state machine decided
 * against a row that was read earlier, and between the read and the write
 * another surface may have answered the same proposal. Losing that race must
 * not produce an audit row for a transition that did not happen, so the
 * transaction rolls back and the caller re-reads: a Telegram tap and a click in
 * the UI a second apart end with one decision and one ledger row, not two.
 *
 * Guideline 2 lives here. An approval writes `intents` and nothing else - there
 * is no broker call to disable, because there is no broker client in the
 * repository. An undo revokes that row in the same transaction, so the ledger
 * and the proposal can never disagree about whether assent stands.
 */
export function applyProposalTransition(transition: TransitionToApply): Promise<TransitionResult> {
  return transaction(async (client) => {
    const updated = await client.query(
      `UPDATE proposals
          SET state = $1,
              snoozed_until = $2,
              decided_at = now(),
              decided_via = $3,
              updated_at = now()
        WHERE id = $4
          AND user_id = $5
          AND state = $6
        RETURNING id`,
      [
        transition.toState,
        transition.snoozedUntil,
        transition.surface,
        transition.proposalId,
        transition.userId,
        transition.fromState,
      ],
    );
    if (updated.rowCount === 0) return { applied: false, intentId: null };

    await client.query(
      `INSERT INTO proposal_transitions
         (proposal_id, user_id, from_state, to_state, surface, actor_user_id,
          evidence_snapshot, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [
        transition.proposalId,
        transition.userId,
        transition.fromState,
        transition.toState,
        transition.surface,
        transition.actorUserId,
        JSON.stringify(transition.evidenceSnapshot ?? {}),
        transition.idempotencyKey,
      ],
    );

    if (transition.revokeIntent) {
      // Marked, never deleted - see migration 0014. The partial unique index
      // allows one *live* intent per proposal, so revoking this one is what
      // lets a later re-approval write its own row.
      await client.query(
        `UPDATE intents
            SET revoked_at = now(), revoked_via = $3
          WHERE proposal_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
        [transition.proposalId, transition.userId, transition.surface],
      );
    }

    let intentId: string | null = null;
    if (transition.intent !== null) {
      const intent = await client.query<{ id: string }>(
        `INSERT INTO intents (user_id, proposal_id, kind, payload)
         VALUES ($1, $2, $3, $4::jsonb)
         RETURNING id`,
        [
          transition.userId,
          transition.proposalId,
          transition.intent.kind,
          JSON.stringify(transition.intent.payload ?? {}),
        ],
      );
      intentId = intent.rows[0]?.id ?? null;
    }

    return { applied: true, intentId };
  });
}

export interface TransitionRow {
  id: string;
  from_state: string;
  to_state: string;
  surface: string;
  actor_user_id: string | null;
  created_at: Date;
}

/** The audit trail for one proposal, newest first. */
export function listProposalTransitions(
  userId: string,
  proposalId: string,
): Promise<TransitionRow[]> {
  return query<TransitionRow>(
    `SELECT id, from_state, to_state, surface, actor_user_id, created_at
       FROM proposal_transitions
      WHERE user_id = $1 AND proposal_id = $2
      ORDER BY created_at DESC`,
    [userId, proposalId],
  );
}

// --- Per-user settings ---------------------------------------------------------

export interface UserSettingsRow {
  proposal_severity: string;
  proposal_ttl_hours: number;
  notify_severity: string;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  muted_until: Date | null;
}

export interface UserSettingsInput {
  proposalSeverity: string;
  proposalTtlHours: number;
  notifySeverity: string;
  /** `HH:MM`, or null together with its pair. */
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  /** ISO 8601 UTC, or null to clear the mute. */
  mutedUntil: string | null;
}

/**
 * The projection both settings statements return, named once so a read and a
 * write cannot drift into disagreeing about the shape they hand back.
 *
 * The two `time` columns are rendered as `HH:MM` here rather than in the route.
 * A `time` reaches the driver as a string in whatever form Postgres chose, and
 * formatting it at the only place that knows it is a `time` keeps the wire
 * format out of reach of a later caller who would guess at it.
 */
const USER_SETTINGS_COLUMNS = `proposal_severity, proposal_ttl_hours, notify_severity,
               to_char(quiet_hours_start, 'HH24:MI') AS quiet_hours_start,
               to_char(quiet_hours_end, 'HH24:MI') AS quiet_hours_end,
               muted_until`;

/**
 * A user's settings, materialising the defaults if they have never saved any.
 *
 * The INSERT is what keeps "no row" from being a case every caller has to
 * handle: the defaults live in the schema (migration 0006), which is the only
 * place they can be stated once for both services. `DO UPDATE` rather than
 * `DO NOTHING` so the statement always returns the row - `DO NOTHING` returns
 * nothing on conflict, which would need a second SELECT for the common path.
 */
export async function getOrCreateUserSettings(userId: string): Promise<UserSettingsRow> {
  const row = await queryOne<UserSettingsRow>(
    `INSERT INTO user_settings (user_id) VALUES ($1)
     ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
     RETURNING ${USER_SETTINGS_COLUMNS}`,
    [userId],
  );
  // The INSERT ... RETURNING always yields a row; the null branch exists only to
  // satisfy the type, and would mean the user was deleted mid-request.
  if (row === null) throw new Error(`user_settings could not be materialised for ${userId}`);
  return row;
}

// --- Notifications -------------------------------------------------------------

export interface NotificationToRecord {
  userId: string;
  channel: string;
  refKind: string;
  refId: string;
  route: string;
  reason: string;
  status: string;
  dedupeKey: string;
}

export interface NotificationRow {
  id: string;
  channel: string;
  ref_kind: string;
  ref_id: string;
  route: string;
  reason: string;
  status: string;
  dedupe_key: string;
  sent_at: Date | null;
  created_at: Date;
}

/**
 * Claim a notification before sending it.
 *
 * The INSERT *is* the claim: `dedupe_key` is unique, so a row coming back means
 * this process is the one that gets to send, and no row means somebody already
 * did. The order is what matters here - claim, then send, then mark. Sending
 * first and recording afterwards leaves a window in which a crash loses the
 * record of a message that already reached the user, and the retry then sends
 * it again. A message cannot be recalled, so the window has to be on the side
 * that costs a missing row rather than a duplicate alert.
 */
export async function claimNotification(
  notification: NotificationToRecord,
): Promise<{ id: string } | null> {
  return queryOne<{ id: string }>(
    `INSERT INTO notifications
       (user_id, channel, ref_kind, ref_id, route, reason, status, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [
      notification.userId,
      notification.channel,
      notification.refKind,
      notification.refId,
      notification.route,
      notification.reason,
      notification.status,
      notification.dedupeKey,
    ],
  );
}

/**
 * Record what became of a claimed notification.
 *
 * `sent_at` is set here rather than at claim time because the two are genuinely
 * different moments - a digest entry is claimed when it is deferred and sent
 * hours later - and the database refuses a 'sent' row without one.
 */
export async function settleNotification(
  id: string,
  status: 'sent' | 'failed' | 'suppressed',
  error?: string,
): Promise<void> {
  await query(
    `UPDATE notifications
        SET status = $2,
            sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE NULL END,
            error = $3
      WHERE id = $1`,
    [id, status, error ?? null],
  );
}

/** Everything deferred into the digest and not yet rolled up. */
export function listPendingDigest(userId: string, limit = 100): Promise<NotificationRow[]> {
  return query<NotificationRow>(
    `SELECT id, channel, ref_kind, ref_id, route, reason, status, dedupe_key,
            sent_at, created_at
       FROM notifications
      WHERE user_id = $1
        AND channel = 'digest'
        AND status = 'pending'
      ORDER BY created_at ASC
      LIMIT $2`,
    [userId, limit],
  );
}

/** The notification log, newest first: what the user was told, and what they were not. */
export function listNotifications(userId: string, limit = 50): Promise<NotificationRow[]> {
  return query<NotificationRow>(
    `SELECT id, channel, ref_kind, ref_id, route, reason, status, dedupe_key,
            sent_at, created_at
       FROM notifications
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [userId, limit],
  );
}

/**
 * Write the whole settings object, creating the row on a first save.
 *
 * Every column is assigned on both paths, including any the user left where it
 * was. That is what makes this a replace rather than a patch: a column left out
 * of the UPDATE would silently keep a value the user has just chosen to drop,
 * and the expensive instance of that is a cleared mute that stays muted - the
 * user hears nothing and has been told they will.
 *
 * The row is returned rather than the input echoed back, so what the caller
 * renders is what the database holds: a `time` the client sent as `07:00` comes
 * back as the database's own reading of it, and the quiet-hours pair CHECK has
 * already had its say by then.
 */
export async function replaceUserSettings(
  userId: string,
  input: UserSettingsInput,
): Promise<UserSettingsRow> {
  const row = await queryOne<UserSettingsRow>(
    `INSERT INTO user_settings (user_id, proposal_severity, proposal_ttl_hours, notify_severity,
                                quiet_hours_start, quiet_hours_end, muted_until, updated_at)
     VALUES ($1, $2, $3, $4, $5::time, $6::time, $7::timestamptz, now())
     ON CONFLICT (user_id) DO UPDATE
        SET proposal_severity  = EXCLUDED.proposal_severity,
            proposal_ttl_hours = EXCLUDED.proposal_ttl_hours,
            notify_severity    = EXCLUDED.notify_severity,
            quiet_hours_start  = EXCLUDED.quiet_hours_start,
            quiet_hours_end    = EXCLUDED.quiet_hours_end,
            muted_until        = EXCLUDED.muted_until,
            updated_at         = now()
     RETURNING ${USER_SETTINGS_COLUMNS}`,
    [
      userId,
      input.proposalSeverity,
      input.proposalTtlHours,
      input.notifySeverity,
      input.quietHoursStart,
      input.quietHoursEnd,
      input.mutedUntil,
    ],
  );
  if (row === null) throw new Error(`user_settings could not be written for ${userId}`);
  return row;
}

// --- Telegram bindings ---------------------------------------------------------

export interface TelegramBindingRow {
  user_id: string;
  chat_id: string;
  username: string | null;
  bound_at: Date;
}

/**
 * Redeem a bind token and bind the chat, or report why not - atomically.
 *
 * Both halves are one transaction because the nonce insert *is* the
 * single-use check: if it succeeds this tap is the first, and the binding
 * follows. Doing the check as a SELECT and the write afterwards leaves the
 * window two simultaneous taps both pass through, which is precisely the
 * mechanism a replayed deep link would exploit.
 *
 * `chat_id` crosses as a string because Telegram ids are 64-bit and JavaScript
 * numbers are not; `bigint` on the way in, text on the way out, and never a
 * `Number` in between.
 */
export function redeemTelegramBindToken(input: {
  nonce: string;
  userId: string;
  chatId: string;
  username: string | null;
}): Promise<{ bound: boolean; reason?: 'already_used' | 'chat_taken' }> {
  return transaction(async (client) => {
    const spent = await client.query(
      `INSERT INTO telegram_bind_tokens (nonce, user_id, chat_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (nonce) DO NOTHING
       RETURNING nonce`,
      [input.nonce, input.userId, input.chatId],
    );
    if (spent.rowCount === 0) return { bound: false, reason: 'already_used' as const };

    // Re-binding the same user to a new chat is legitimate - a new phone - so
    // the user's own row is replaced. What is refused is one chat speaking for
    // two users, which the unique on chat_id enforces and which has no sensible
    // reading at all.
    try {
      await client.query(
        `INSERT INTO telegram_bindings (user_id, chat_id, username)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE
           SET chat_id = EXCLUDED.chat_id,
               username = EXCLUDED.username,
               bound_at = now()`,
        [input.userId, input.chatId, input.username],
      );
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        return { bound: false, reason: 'chat_taken' as const };
      }
      throw error;
    }
    return { bound: true };
  });
}

/** The chat a user's alerts go to, if they have connected one. */
export function findTelegramBindingByUser(userId: string): Promise<TelegramBindingRow | null> {
  return queryOne<TelegramBindingRow>(
    `SELECT user_id, chat_id::text AS chat_id, username, bound_at
       FROM telegram_bindings WHERE user_id = $1`,
    [userId],
  );
}

/**
 * The user a chat speaks for, if any.
 *
 * The webhook's authorisation check. An unbound chat resolves to null and is
 * ignored in silence (FLOWS.md F4) - answering it would confirm the bot exists
 * to anybody who found it, and there is nothing useful to say to a stranger.
 */
export function findTelegramBindingByChat(chatId: string): Promise<TelegramBindingRow | null> {
  return queryOne<TelegramBindingRow>(
    `SELECT user_id, chat_id::text AS chat_id, username, bound_at
       FROM telegram_bindings WHERE chat_id = $1`,
    [chatId],
  );
}

/** Disconnect a chat. `/stop` - the user's own off switch. */
export async function deleteTelegramBinding(userId: string): Promise<boolean> {
  const rows = await query<{ user_id: string }>(
    `DELETE FROM telegram_bindings WHERE user_id = $1 RETURNING user_id`,
    [userId],
  );
  return rows.length > 0;
}

/** Silence pushes until a moment. `/mute` - set on the settings row. */
export async function muteUntil(userId: string, until: Date | null): Promise<void> {
  await query(
    `INSERT INTO user_settings (user_id, muted_until) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET muted_until = EXCLUDED.muted_until, updated_at = now()`,
    [userId, until],
  );
}

// --- Topics and their confirmed instruments (M5) ------------------------------

export type TopicStatus = 'active' | 'proposed' | 'rejected' | 'expired';

/**
 * The statuses a user sees and can act on. `rejected` and `expired` rows are
 * auto-discovery's memory and leave every list; each reader filters by this
 * rather than by excluding one dead status, so a third cannot slip through.
 */
const LIVE_TOPIC = `status IN ('active', 'proposed')`;

export interface TopicRow {
  id: string;
  label: string;
  status: TopicStatus;
  created_by: 'user' | 'auto';
  proposal_band: ProposalBand | null;
  created_at: Date;
  updated_at: Date;
  confirmed_at: Date | null;
  instrument_count: number;
  /** Why an auto-discovered topic was proposed; null for a topic the user created. */
  evidence: TopicEvidence | null;
}

export interface TopicInstrumentRow {
  instrument_id: string;
  symbol: string;
  name: string | null;
  asset_class: AssetClass;
  source: 'resolver' | 'user';
  confidence: 'confident' | 'weak' | null;
  rationale: string | null;
  /** `[{ etf, weight }]`, weights as decimal strings, exactly as offered. */
  held_by: { etf: string; weight: string }[];
  added_at: Date;
}

/** One confirmed instrument, with the reasons it was offered (none for `user`). */
export interface TopicInstrumentInput {
  instrumentId: string;
  source: 'resolver' | 'user';
  confidence: 'confident' | 'weak' | null;
  rationale: string | null;
  heldBy: { etf: string; weight: string }[];
}

const TOPIC_COLUMNS = `
  t.id, t.label, t.status, t.created_by, t.proposal_band, t.created_at, t.updated_at,
  t.confirmed_at, t.evidence,
  (SELECT count(*)::int FROM topic_instruments ti WHERE ti.topic_id = t.id) AS instrument_count`;

/**
 * The user's topics, newest first. Rejected and expired proposals are excluded:
 * they exist only as auto-discovery's memory of what not to propose again.
 */
export function listTopics(userId: string): Promise<TopicRow[]> {
  return query<TopicRow>(
    `SELECT ${TOPIC_COLUMNS}
       FROM topics t
      WHERE t.user_id = $1 AND t.${LIVE_TOPIC}
      ORDER BY t.created_at DESC, t.id`,
    [userId],
  );
}

export function getTopic(userId: string, topicId: string): Promise<TopicRow | null> {
  return queryOne<TopicRow>(
    `SELECT ${TOPIC_COLUMNS}
       FROM topics t
      WHERE t.user_id = $1 AND t.id = $2 AND t.${LIVE_TOPIC}`,
    [userId, topicId],
  );
}

/** A topic's confirmed instruments: resolver picks first, then additions, by symbol. */
export function listTopicInstruments(
  userId: string,
  topicId: string,
): Promise<TopicInstrumentRow[]> {
  return query<TopicInstrumentRow>(
    `SELECT ti.instrument_id, i.symbol, i.name, i.asset_class, ti.source, ti.confidence,
            ti.rationale, ti.held_by, ti.added_at
       FROM topic_instruments ti
       JOIN instruments i ON i.id = ti.instrument_id
      WHERE ti.user_id = $1 AND ti.topic_id = $2
      ORDER BY ti.source = 'user', i.symbol`,
    [userId, topicId],
  );
}

/**
 * Serialise every topic write for one user, and report how many topics are live.
 *
 * The count-then-insert behind the topic cap is a race without this: two
 * simultaneous confirms both read nine and both write a tenth. Locking the
 * user's row makes the second wait for the first, then count again. `proposed`
 * topics do not count - auto-discovery's own bound is its business, and a
 * proposal must not be able to use up the user's room for topics they chose.
 */
export async function lockTopicsForWrite(client: PoolClient, userId: string): Promise<number> {
  await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
  const { rows } = await client.query<{ active: number }>(
    `SELECT count(*)::int AS active FROM topics WHERE user_id = $1 AND status = 'active'`,
    [userId],
  );
  return rows[0]?.active ?? 0;
}

/**
 * The status of `topicId` if it is a live topic of this user, else null. Locks
 * the row for the rest of the transaction.
 */
export async function lockTopic(
  client: PoolClient,
  userId: string,
  topicId: string,
): Promise<TopicStatus | null> {
  const { rows } = await client.query<{ status: TopicStatus }>(
    `SELECT status FROM topics
      WHERE user_id = $1 AND id = $2 AND ${LIVE_TOPIC}
      FOR UPDATE`,
    [userId, topicId],
  );
  return rows[0]?.status ?? null;
}

/**
 * Write a confirmed topic's label: a new active topic when `topicId` is null,
 * otherwise a relabel of an existing one. Confirming is what makes a topic
 * active, so both stamp `confirmed_at`.
 *
 * Returns `duplicate` instead of throwing when the label is already a live
 * topic of this user (compared case-insensitively by the unique index), so the
 * route can say which topic it collided with rather than surfacing a 500.
 */
export async function writeConfirmedTopic(
  client: PoolClient,
  input: { userId: string; topicId: string | null; label: string },
): Promise<{ id: string } | { duplicate: true }> {
  try {
    const { rows } =
      input.topicId === null
        ? await client.query<{ id: string }>(
            `INSERT INTO topics (user_id, label, status, created_by, confirmed_at)
           VALUES ($1, $2, 'active', 'user', now())
           RETURNING id`,
            [input.userId, input.label],
          )
        : await client.query<{ id: string }>(
            `UPDATE topics
              SET label = $3, status = 'active', confirmed_at = now(), updated_at = now()
            WHERE user_id = $1 AND id = $2
           RETURNING id`,
            [input.userId, input.topicId, input.label],
          );
    return { id: rows[0]!.id };
  } catch (error) {
    if ((error as { code?: string }).code === '23505') return { duplicate: true };
    throw error;
  }
}

/**
 * Make `instruments` exactly the topic's confirmed set.
 *
 * Rows that stay keep their `added_at` - "confirmed since March" should not
 * reset every time the user edits the list - and take the provenance offered
 * this time. Rows not in the set are deleted.
 */
export async function replaceTopicInstruments(
  client: PoolClient,
  userId: string,
  topicId: string,
  instruments: TopicInstrumentInput[],
): Promise<void> {
  await client.query(
    `DELETE FROM topic_instruments
      WHERE user_id = $1 AND topic_id = $2 AND NOT (instrument_id = ANY($3::uuid[]))`,
    [userId, topicId, instruments.map((i) => i.instrumentId)],
  );
  for (const instrument of instruments) {
    await client.query(
      `INSERT INTO topic_instruments
              (topic_id, user_id, instrument_id, source, confidence, rationale, held_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (topic_id, instrument_id) DO UPDATE
          SET source = EXCLUDED.source,
              confidence = EXCLUDED.confidence,
              rationale = EXCLUDED.rationale,
              held_by = EXCLUDED.held_by`,
      [
        topicId,
        userId,
        instrument.instrumentId,
        instrument.source,
        instrument.confidence,
        instrument.rationale,
        JSON.stringify(instrument.heldBy),
      ],
    );
  }
}

export interface ActiveTopicInstrumentRow {
  topic_id: string;
  label: string;
  instrument_id: string;
  symbol: string;
}

/**
 * Every active topic's confirmed instruments, one row per pair, for the topic
 * scan. Ordered so rows of one topic are adjacent and the scan can group them
 * without sorting.
 */
export function listActiveTopicInstruments(userId: string): Promise<ActiveTopicInstrumentRow[]> {
  return query<ActiveTopicInstrumentRow>(
    `SELECT t.id AS topic_id, t.label, i.id AS instrument_id, i.symbol
       FROM topics t
       JOIN topic_instruments ti ON ti.topic_id = t.id AND ti.user_id = t.user_id
       JOIN instruments i ON i.id = ti.instrument_id
      WHERE t.user_id = $1 AND t.status = 'active'
      ORDER BY t.created_at, t.id, i.symbol`,
    [userId],
  );
}

export interface TopicArticleRow {
  id: string;
  url: string;
  source: string;
  title: string;
  published_at: Date | null;
  fetched_at: Date;
  instruments: {
    symbol: string;
    match_method: string;
    matched_text: string | null;
    salience: string;
  }[];
  sentiment: { score: string; magnitude: string; model: string } | null;
}

/**
 * A topic's news: articles linked to any of its confirmed instruments.
 *
 * Derived here rather than stored as topic links, because articles are shared
 * market data and a topic is one user's choice (migration 0018). Syndicated
 * copies (`duplicate_of_id`) are left out: the original carries the links, and
 * one wire story is one item. An undated article is dated by when it was fetched
 * for the window, so it is neither hidden nor given a publication time.
 */
export function listTopicArticles(
  userId: string,
  topicId: string,
  days: number,
  limit = 30,
): Promise<TopicArticleRow[]> {
  return query<TopicArticleRow>(
    `SELECT a.id, a.url, a.source, a.title, a.published_at, a.fetched_at,
            json_agg(json_build_object(
              'symbol', i.symbol,
              'match_method', ae.match_method,
              'matched_text', ae.matched_text,
              'salience', ae.salience::text
            ) ORDER BY ae.salience DESC, i.symbol) AS instruments,
            (SELECT json_build_object('score', s.score::text, 'magnitude', s.magnitude::text,
                                      'model', s.model)
               FROM article_sentiment s
              WHERE s.article_id = a.id
              ORDER BY s.created_at DESC
              LIMIT 1) AS sentiment
       FROM topic_instruments ti
       JOIN article_entities ae ON ae.instrument_id = ti.instrument_id
       JOIN articles a ON a.id = ae.article_id
       JOIN instruments i ON i.id = ti.instrument_id
      WHERE ti.user_id = $1 AND ti.topic_id = $2
        AND a.duplicate_of_id IS NULL
        AND coalesce(a.published_at, a.fetched_at) > now() - ($3 || ' days')::interval
      GROUP BY a.id
      ORDER BY coalesce(a.published_at, a.fetched_at) DESC, a.id
      LIMIT $4`,
    [userId, topicId, String(days), limit],
  );
}

export interface InstrumentArticleRow extends TopicArticleRow {
  /** Every article in the window, not only this page: `count(*) OVER ()`. */
  total: string;
}

/**
 * A holding's news: articles linked to its instrument, newest first.
 *
 * Ownership goes through `holdings` - articles are shared market data with no
 * `user_id`, so the holding row is what makes this one user's question. Shaped
 * like `listTopicArticles` so both render with one component; `instruments`
 * carries only this holding's link, the one that brought the article here.
 */
export function listHoldingArticles(
  userId: string,
  holdingId: string,
  days: number,
  limit = 20,
): Promise<InstrumentArticleRow[]> {
  return query<InstrumentArticleRow>(
    `SELECT a.id, a.url, a.source, a.title, a.published_at, a.fetched_at,
            json_build_array(json_build_object(
              'symbol', i.symbol,
              'match_method', ae.match_method,
              'matched_text', ae.matched_text,
              'salience', ae.salience::text
            )) AS instruments,
            (SELECT json_build_object('score', s.score::text, 'magnitude', s.magnitude::text,
                                      'model', s.model)
               FROM article_sentiment s
              WHERE s.article_id = a.id
              ORDER BY s.created_at DESC
              LIMIT 1) AS sentiment,
            count(*) OVER ()::text AS total
       FROM holdings h
       JOIN instruments i ON i.id = h.instrument_id
       JOIN article_entities ae ON ae.instrument_id = h.instrument_id
       JOIN articles a ON a.id = ae.article_id
      WHERE h.user_id = $1 AND h.id = $2
        AND a.duplicate_of_id IS NULL
        AND coalesce(a.published_at, a.fetched_at) > now() - ($3 || ' days')::interval
      ORDER BY coalesce(a.published_at, a.fetched_at) DESC, a.id
      LIMIT $4`,
    [userId, holdingId, String(days), limit],
  );
}

export interface TopicSentimentRow {
  id: string;
  url: string;
  source: string;
  title: string;
  published_at: Date | null;
  fetched_at: Date;
  /** The article's day in the user's timezone, `YYYY-MM-DD`. */
  local_day: string;
  /** Null for an article no scorer has read. */
  model: string | null;
  score: string | null;
  magnitude: string | null;
}

/**
 * Every opinion on every article in a topic's window, one row per (article, model).
 *
 * The same article set as `listTopicArticles` - linked through a confirmed
 * instrument, syndicated copies excluded - but unlimited within the window,
 * because an average over the first thirty articles is not the topic's average.
 * Articles no scorer has read come back with a null model, so the caller can say
 * how many were left out rather than silently shrinking the denominator. Days are
 * bucketed in the user's timezone (guideline 10).
 */
export function listTopicSentimentRows(
  userId: string,
  topicId: string,
  days: number,
  timezone: string,
): Promise<TopicSentimentRow[]> {
  return query<TopicSentimentRow>(
    `WITH linked AS (
       SELECT DISTINCT a.id, a.url, a.source, a.title, a.published_at, a.fetched_at,
              coalesce(a.published_at, a.fetched_at) AS dated_at
         FROM topic_instruments ti
         JOIN article_entities ae ON ae.instrument_id = ti.instrument_id
         JOIN articles a ON a.id = ae.article_id
        WHERE ti.user_id = $1 AND ti.topic_id = $2
          AND a.duplicate_of_id IS NULL
          AND coalesce(a.published_at, a.fetched_at) > now() - ($3 || ' days')::interval
     )
     SELECT l.id, l.url, l.source, l.title, l.published_at, l.fetched_at,
            to_char((l.dated_at AT TIME ZONE $4)::date, 'YYYY-MM-DD') AS local_day,
            s.model, s.score::text AS score, s.magnitude::text AS magnitude
       FROM linked l
       LEFT JOIN article_sentiment s ON s.article_id = l.id
      ORDER BY l.dated_at DESC, l.id, s.model
      LIMIT 2000`,
    [userId, topicId, String(days), timezone],
  );
}

/** Topic observations written in the last `hours`, most severe first, for the digest. */
export function listRecentTopicObservations(
  userId: string,
  hours: number,
): Promise<{ subject_ref: string; severity: string; headline: string; created_at: Date }[]> {
  return query(
    `SELECT subject_ref, severity, headline, created_at
       FROM observations
      WHERE user_id = $1
        AND subject_kind = 'topic'
        AND created_at > now() - ($2 || ' hours')::interval
      ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'notable' THEN 1 ELSE 2 END,
               created_at DESC`,
    [userId, String(hours)],
  );
}

/** Delete one of the user's topics and, by cascade, its instruments. */
/**
 * Delete a topic the user follows. A proposal is not deleted here: forgetting it
 * would erase the memory that stops it being proposed again, so a proposal is
 * declined with `rejectProposal` instead, and the route says so.
 */
export async function deleteTopic(userId: string, topicId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `DELETE FROM topics WHERE user_id = $1 AND id = $2 AND status = 'active' RETURNING id`,
    [userId, topicId],
  );
  return rows.length > 0;
}

// --- Auto-discovery and rejection memory (FR-11) ------------------------------

/** A topic discovery compares a new theme against, with its fingerprint. */
export interface KnownThemeRow {
  id: string;
  label: string;
  status: TopicStatus;
  /** An auto-proposal's band; null for a topic the user created. */
  proposal_band: ProposalBand | null;
  /** Stored on auto topics when proposed; null for a topic the user created. */
  match_words: string[] | null;
  /** Confirmed instruments of an active topic; the offered set of a proposal. */
  instrument_ids: string[];
}

/**
 * Every theme a new proposal must not repeat: the user's active topics, their
 * open proposals, what they rejected within the last `cooldownDays`, and the
 * proposals that expired unanswered within the last `expiredDays`.
 *
 * An active topic is compared by the instruments the user *confirmed*, since
 * that is what they follow now; a proposal or a rejection by the set it was
 * offered with, frozen when it was proposed, so a later change to the universe
 * cannot quietly un-reject it.
 */
export function listKnownThemes(
  userId: string,
  cooldownDays: number,
  expiredDays: number,
): Promise<KnownThemeRow[]> {
  return query<KnownThemeRow>(
    `SELECT t.id, t.label, t.status, t.proposal_band, t.match_words,
            CASE WHEN t.status = 'active'
                 THEN coalesce((SELECT array_agg(ti.instrument_id::text ORDER BY ti.instrument_id)
                                  FROM topic_instruments ti
                                 WHERE ti.topic_id = t.id), '{}')
                 ELSE coalesce(t.proposed_instruments::text[], '{}')
            END AS instrument_ids
       FROM topics t
      WHERE t.user_id = $1
        AND (t.${LIVE_TOPIC}
             OR (t.status = 'rejected' AND t.rejected_at >= now() - make_interval(days => $2::int))
             OR (t.status = 'expired' AND t.expired_at >= now() - make_interval(days => $3::int)))
      ORDER BY t.created_at, t.id`,
    [userId, cooldownDays, expiredDays],
  );
}

/**
 * Expire this user's proposals that have waited `ttlDays` or more for an
 * answer, and return their labels. Run under `lockTopicsForWrite`, so a confirm
 * or a reject racing it either lands first (and the row is no longer
 * `proposed`) or waits and finds it expired.
 *
 * Measured from `created_at`, since a proposal is never edited while it waits.
 */
export async function expireProposals(
  client: PoolClient,
  userId: string,
  ttlDays: number,
): Promise<string[]> {
  const { rows } = await client.query<{ label: string }>(
    `UPDATE topics
        SET status = 'expired', expired_at = now(), updated_at = now()
      WHERE user_id = $1 AND status = 'proposed'
        AND created_at <= now() - make_interval(days => $2::int)
     RETURNING label`,
    [userId, ttlDays],
  );
  return rows.map((row) => row.label).sort();
}

/**
 * Open proposals by band, counted under the lock `lockTopicsForWrite` takes.
 * Each band has its own cap, so they are never summed.
 */
export async function countOpenProposals(
  client: PoolClient,
  userId: string,
): Promise<Record<ProposalBand, number>> {
  const { rows } = await client.query<{ band: ProposalBand; open: number }>(
    `SELECT proposal_band AS band, count(*)::int AS open
       FROM topics
      WHERE user_id = $1 AND status = 'proposed'
      GROUP BY proposal_band`,
    [userId],
  );
  const open: Record<ProposalBand, number> = { confident: 0, weak: 0 };
  for (const row of rows) open[row.band] = row.open;
  return open;
}

export interface ProposalInput {
  userId: string;
  label: string;
  matchWords: string[];
  instrumentIds: string[];
  evidence: TopicEvidence;
  band: ProposalBand;
}

/**
 * Write one auto-proposal. Returns `duplicate` when the label is already a live
 * topic of this user; the matching rule should have caught that first, so this
 * is the index's last word rather than the normal path.
 */
export async function insertProposal(
  client: PoolClient,
  input: ProposalInput,
): Promise<{ id: string } | { duplicate: true }> {
  try {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO topics
              (user_id, label, status, created_by, match_words, proposed_instruments, evidence,
               proposal_band)
       VALUES ($1, $2, 'proposed', 'auto', $3::text[], $4::uuid[], $5::jsonb, $6)
       RETURNING id`,
      [
        input.userId,
        input.label,
        input.matchWords,
        input.instrumentIds,
        JSON.stringify(input.evidence),
        input.band,
      ],
    );
    return { id: rows[0]!.id };
  } catch (error) {
    if ((error as { code?: string }).code === '23505') return { duplicate: true };
    throw error;
  }
}

/**
 * Decline a proposal: it becomes rejection memory, and leaves every list.
 *
 * `not_a_proposal` when the topic exists but is one the user follows - a
 * followed topic is deleted, not rejected, and the constraint in migration 0019
 * would refuse the write anyway.
 */
export async function rejectProposal(
  userId: string,
  topicId: string,
): Promise<'rejected' | 'not_found' | 'not_a_proposal'> {
  const rows = await query<{ status: TopicStatus; rejected: boolean }>(
    `WITH target AS (
       SELECT id, status FROM topics
        WHERE user_id = $1 AND id = $2 AND ${LIVE_TOPIC}
     ),
     updated AS (
       UPDATE topics t
          SET status = 'rejected', rejected_at = now(), updated_at = now()
         FROM target
        -- Re-checked on the row itself: a confirm that won the race has
        -- already made it active, and an active topic is not rejected.
        WHERE t.id = target.id AND t.status = 'proposed'
       RETURNING t.id
     )
     SELECT target.status, EXISTS (SELECT 1 FROM updated) AS rejected FROM target`,
    [userId, topicId],
  );
  const row = rows[0];
  if (!row) return 'not_found';
  return row.rejected ? 'rejected' : 'not_a_proposal';
}

export { transaction };
