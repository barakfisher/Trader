/**
 * Every SQL statement in the orchestrator. Keeping them together makes the data
 * access surface auditable and keeps SQL out of the HTTP layer.
 */

import type { PoolClient } from 'pg';
import type { AssetClass } from '@traders/shared';

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
  as_of: Date;
  total_minor: string;
  cost_minor: string;
  currency: string;
  holdings_count: number;
  priced_count: number;
  degraded: boolean;
}

export function getUser(userId: string): Promise<UserRow | null> {
  return queryOne<UserRow>(
    'SELECT id, email, base_currency, timezone FROM users WHERE id = $1',
    [userId],
  );
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
    return client
      .query<{ id: string; inserted: boolean }>(sql, params)
      .then((r) => r.rows[0]!);
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
    values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`);
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
    `SELECT as_of, total_minor::text AS total_minor, cost_minor::text AS cost_minor, currency,
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
  await query(
    `UPDATE runs SET status = $2, finished_at = now(), stats = $3::jsonb WHERE id = $1`,
    [runId, status, JSON.stringify(stats)],
  );
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
}

/**
 * Store observations, skipping any the feed has already reported.
 *
 * `dedupe_key` is unique, so a re-scan over unchanged data inserts nothing and
 * the count of suppressed rows is the honest measure of how repetitive the scan
 * is. Suppression is silent by design at this layer and loud in the run stats:
 * nothing is lost, because an identical finding says nothing new.
 */
export async function insertObservations(
  observations: ObservationToStore[],
): Promise<{ created: number; suppressed: number }> {
  if (observations.length === 0) return { created: 0, suppressed: 0 };

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
    );
    values.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, ` +
        `$${base + 7}, $${base + 8}, $${base + 9}::jsonb, $${base + 10}::text[], $${base + 11})`,
    );
  });

  const inserted = await query<{ id: string }>(
    `INSERT INTO observations
       (user_id, run_id, kind, severity, subject_kind, subject_ref, headline, explanation,
        evidence, concept_refs, dedupe_key)
     VALUES ${values.join(', ')}
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    params,
  );
  return { created: inserted.length, suppressed: observations.length - inserted.length };
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
/** The instruments a user holds, for backfilling their price history. */
export function listHeldInstruments(userId: string): Promise<{ id: string; symbol: string }[]> {
  return query<{ id: string; symbol: string }>(
    `SELECT DISTINCT i.id, i.symbol
       FROM holdings h
       JOIN instruments i ON i.id = h.instrument_id
      WHERE h.user_id = $1
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

export function listObservations(userId: string, limit = 50): Promise<ObservationRow[]> {
  return query<ObservationRow>(
    `SELECT id, kind, severity, subject_kind, subject_ref, headline, explanation,
            evidence, concept_refs, created_at
       FROM observations
      WHERE user_id = $1
      ORDER BY created_at DESC, severity DESC
      LIMIT $2`,
    [userId, limit],
  );
}

export { transaction };
