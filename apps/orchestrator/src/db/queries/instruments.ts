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

/**
 * Whether instrument `i` is one this user may learn exists (D339): the
 * installation's own list - the screened universe and its former members - or
 * a symbol the user holds, has traded or has targeted, in any portfolio.
 *
 * `instruments` also keeps every symbol any user ever added, so a lookup that
 * answered "known" for all of it would tell one user what another holds: a
 * symbol only someone else added must read exactly like one nobody added.
 * `$userParam` names the user id's placeholder.
 */
function visibleToUser(userParam: string): string {
  return `(EXISTS (SELECT 1 FROM instrument_profiles vp
                    WHERE vp.instrument_id = i.id AND vp.membership IN ('screened', 'dropped'))
          -- agent-blind: a symbol the user holds, traded or targeted in any portfolio, real or simulated, is theirs.
          OR EXISTS (SELECT 1 FROM holdings vh WHERE vh.instrument_id = i.id AND vh.user_id = ${userParam})
          OR EXISTS (SELECT 1 FROM fills vf WHERE vf.instrument_id = i.id AND vf.user_id = ${userParam})
          OR EXISTS (SELECT 1 FROM target_weights vt WHERE vt.instrument_id = i.id AND vt.user_id = ${userParam}))`;
}

/**
 * Look up instruments by symbol, so a write can reject names we have never
 * resolved. Installation callers only (benchmarks, performance): a user's
 * request asks `findVisibleInstrumentsBySymbols`.
 */
export function findInstrumentsBySymbols(symbols: string[]): Promise<InstrumentRow[]> {
  if (symbols.length === 0) return Promise.resolve([]);
  return query<InstrumentRow>(
    `SELECT id, symbol, name, asset_class, exchange, currency
       FROM instruments
      WHERE symbol = ANY($1::text[])`,
    [symbols.map((symbol) => symbol.toUpperCase())],
  );
}

/** `findInstrumentsBySymbols` as one user may see it (D339): another user's symbols read as unknown. */
export function findVisibleInstrumentsBySymbols(userId: string, symbols: string[]): Promise<InstrumentRow[]> {
  if (symbols.length === 0) return Promise.resolve([]);
  return query<InstrumentRow>(
    `SELECT i.id, i.symbol, i.name, i.asset_class, i.exchange, i.currency
       FROM instruments i
      WHERE i.symbol = ANY($2::text[])
        AND ${visibleToUser('$1')}`,
    [userId, symbols.map((symbol) => symbol.toUpperCase())],
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

export interface UniverseProfileRow {
  asset_class: string;
  sector: string | null;
  industry: string | null;
  category: string | null;
  market_cap_minor: string | null;
  size_currency: string | null;
  /** The equity sector an ETF category holds (D164), when it holds one. */
  category_sector: string | null;
  /** Whether the taxonomy lists the industry / category, so a mandate may name it. */
  industry_listed: boolean;
  category_listed: boolean;
}

/**
 * What the mandate's universe rules read about `symbol` (D301), as the scan's
 * `mandate._profile` reads it: the instrument with its profile, or null when
 * there is no instrument. Installation data: no `user_id`.
 */
export function getUniverseProfile(symbol: string): Promise<UniverseProfileRow | null> {
  return queryOne<UniverseProfileRow>(
    `SELECT i.asset_class, p.sector, p.industry, p.category,
            p.market_cap_minor::text AS market_cap_minor, p.size_currency,
            (SELECT t.sector FROM universe_taxonomy t
              WHERE t.kind = 'etf_category' AND t.name = p.category) AS category_sector,
            EXISTS (SELECT 1 FROM universe_taxonomy t
                     WHERE t.kind = 'industry' AND t.name = p.industry) AS industry_listed,
            EXISTS (SELECT 1 FROM universe_taxonomy t
                     WHERE t.kind = 'etf_category' AND t.name = p.category) AS category_listed
       FROM instruments i
       LEFT JOIN instrument_profiles p ON p.instrument_id = i.id
      WHERE i.symbol = $1`,
    [symbol],
  );
}

export interface TradableInstrumentRow extends InstrumentRow {
  /** `instrument_profiles.membership`, or null when the universe does not hold it. */
  membership: 'screened' | 'on_demand' | 'dropped' | null;
}

/**
 * An instrument by symbol with its universe membership - what a trade checks
 * before anything else (D7, D8): only the universe is tradable, and only in USD.
 * Only an instrument this user may see (D339): another user's symbol is null,
 * as if nobody had added it.
 */
export function findTradableInstrument(userId: string, symbol: string): Promise<TradableInstrumentRow | null> {
  return queryOne<TradableInstrumentRow>(
    `SELECT i.id, i.symbol, i.name, i.asset_class, i.exchange, i.currency, p.membership
       FROM instruments i
       LEFT JOIN instrument_profiles p ON p.instrument_id = i.id
      WHERE i.symbol = $2
        AND ${visibleToUser('$1')}`,
    [userId, symbol.trim().toUpperCase()],
  );
}

export interface InstrumentDirectoryRow {
  symbol: string;
  name: string | null;
  asset_class: AssetClass;
  exchange: string | null;
}

/**
 * The instruments a user may be offered while adding a holding (D324, D325):
 * the screened universe, which is the installation's own reference list, plus
 * whatever this user already holds or has traded. ~5,200 rows (67 KB gzipped,
 * measured 2026-10-27): sent whole once and filtered in the browser.
 *
 * Not all of `instruments`: that table also holds every symbol any user ever
 * added, and listing it would tell one user what another holds (the M9 exit
 * test caught exactly that). A listing outside both is found through the
 * market search instead.
 */
export function listInstrumentDirectory(userId: string): Promise<InstrumentDirectoryRow[]> {
  return query<InstrumentDirectoryRow>(
    `-- agent-blind: a symbol the user holds in any portfolio, real or simulated, is theirs to be offered.
     SELECT i.symbol, i.name, i.asset_class, i.exchange
       FROM instruments i
      WHERE EXISTS (SELECT 1 FROM instrument_profiles p
                     WHERE p.instrument_id = i.id AND p.membership = 'screened')
         OR EXISTS (SELECT 1 FROM holdings h WHERE h.instrument_id = i.id AND h.user_id = $1)
         OR EXISTS (SELECT 1 FROM fills f WHERE f.instrument_id = i.id AND f.user_id = $1)
      ORDER BY i.symbol`,
    [userId],
  );
}
