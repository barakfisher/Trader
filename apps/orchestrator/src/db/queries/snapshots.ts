import { query } from '../pool.js';

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
