import type { PoolClient } from 'pg';
import type { AssetClass } from '@traders/shared';
import { query, queryOne } from '../pool.js';

export interface InstrumentRow {
  id: string;
  symbol: string;
  name: string | null;
  asset_class: AssetClass;
  exchange: string | null;
  currency: string;
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

export interface TradableInstrumentRow extends InstrumentRow {
  /** `instrument_profiles.membership`, or null when the universe does not hold it. */
  membership: 'screened' | 'on_demand' | 'dropped' | null;
}

/**
 * An instrument by symbol with its universe membership - what a trade checks
 * before anything else (D7, D8): only the universe is tradable, and only in USD.
 */
export function findTradableInstrument(symbol: string): Promise<TradableInstrumentRow | null> {
  return queryOne<TradableInstrumentRow>(
    `SELECT i.id, i.symbol, i.name, i.asset_class, i.exchange, i.currency, p.membership
       FROM instruments i
       LEFT JOIN instrument_profiles p ON p.instrument_id = i.id
      WHERE i.symbol = $1`,
    [symbol.trim().toUpperCase()],
  );
}
