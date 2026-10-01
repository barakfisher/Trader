import { queryOne } from '../pool.js';

export interface UniverseLoadRow {
  snapshot_as_of: Date;
  source: string;
  manifest: Record<string, unknown>;
  report: Record<string, number>;
  loaded_at: Date;
}

/** The most recent run of the universe loader and its own account of it. */
export function getLatestUniverseLoad(): Promise<UniverseLoadRow | null> {
  return queryOne<UniverseLoadRow>(
    `SELECT snapshot_as_of, source, manifest, report, loaded_at
       FROM universe_loads
      ORDER BY loaded_at DESC, id DESC
      LIMIT 1`,
  );
}

export interface UniverseCountsRow {
  /** Screened profiles: the ones a snapshot put here, and the only ones a topic sees. */
  profiles: number;
  equities: number;
  etfs: number;
  embedded: number;
  etf_holdings: number;
  /** Fetched for a listing a user named (decision 89); never compared with a snapshot. */
  on_demand: number;
  /** Former members a newer snapshot no longer holds (decision 90); kept, never searched. */
  dropped: number;
}

/** What the database holds now - compared against what the last load wrote. */
export async function countUniverse(): Promise<UniverseCountsRow> {
  const row = await queryOne<UniverseCountsRow>(
    `SELECT count(*) FILTER (WHERE p.membership = 'screened')::int AS profiles,
            count(*) FILTER (WHERE p.membership = 'screened' AND i.asset_class = 'equity')::int
              AS equities,
            count(*) FILTER (WHERE p.membership = 'screened' AND i.asset_class = 'etf')::int AS etfs,
            count(p.embedding_model) FILTER (WHERE p.membership = 'screened')::int AS embedded,
            (SELECT count(*)::int FROM etf_holdings) AS etf_holdings,
            count(*) FILTER (WHERE p.membership = 'on_demand')::int AS on_demand,
            count(*) FILTER (WHERE p.membership = 'dropped')::int AS dropped
       FROM instrument_profiles p
       JOIN instruments i ON i.id = p.instrument_id`,
  );
  return (
    row ?? { profiles: 0, equities: 0, etfs: 0, embedded: 0, etf_holdings: 0, on_demand: 0, dropped: 0 }
  );
}
