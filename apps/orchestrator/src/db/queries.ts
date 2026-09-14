/**
 * Every SQL statement in the orchestrator. Keeping them together makes the data
 * access surface auditable and keeps SQL out of the HTTP layer.
 */

import type { PoolClient } from 'pg';
import type { AssetClass } from '@traders/shared';

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

export interface SnapshotRow {
  as_of: Date;
  total_minor: string;
  cost_minor: string;
  currency: string;
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
}

/** One snapshot per user per day; re-running the job overwrites today's row. */
export async function upsertSnapshot(input: SnapshotInput): Promise<void> {
  await query(
    `INSERT INTO portfolio_snapshots (user_id, as_of, total_minor, cost_minor, currency, breakdown)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (user_id, as_of) DO UPDATE SET
       total_minor = EXCLUDED.total_minor,
       cost_minor  = EXCLUDED.cost_minor,
       currency    = EXCLUDED.currency,
       breakdown   = EXCLUDED.breakdown`,
    [
      input.userId,
      input.asOf,
      input.totalMinor,
      input.costMinor,
      input.currency,
      JSON.stringify(input.breakdown),
    ],
  );
}

export function listSnapshots(userId: string, limit = 365): Promise<SnapshotRow[]> {
  return query<SnapshotRow>(
    `SELECT as_of, total_minor::text AS total_minor, cost_minor::text AS cost_minor, currency
       FROM portfolio_snapshots
      WHERE user_id = $1
      ORDER BY as_of DESC
      LIMIT $2`,
    [userId, limit],
  );
}

export { transaction };
