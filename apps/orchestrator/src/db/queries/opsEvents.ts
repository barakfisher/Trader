import { query } from '../pool.js';

export type OpsEventKind = 'universe_gap_missing_ticker' | 'universe_gap_low_confidence';

export interface OpsEventInput {
  kind: OpsEventKind;
  userId: string | null;
  detail: unknown;
  dedupeKey: string;
}

/**
 * Record a gap, or count one more sighting of it. A repeat keeps the first
 * detail and bumps the count: the same thing seen again is not a new thing.
 */
export async function recordOpsEvent(input: OpsEventInput): Promise<void> {
  await query(
    `INSERT INTO ops_events (kind, user_id, detail, dedupe_key)
     VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (dedupe_key) DO UPDATE
        SET occurrences = ops_events.occurrences + 1, last_seen_at = now()`,
    [input.kind, input.userId, JSON.stringify(input.detail), input.dedupeKey],
  );
}

export interface OpsEventRow {
  id: string;
  kind: OpsEventKind;
  user_id: string | null;
  detail: unknown;
  occurrences: number;
  occurred_at: Date;
  last_seen_at: Date;
  profile_membership: ProfileMembership | null;
}

/** `instrument_profiles.membership` (migration 0030). */
export type ProfileMembership = 'screened' | 'on_demand' | 'dropped';

export function listOpsEvents(kind: OpsEventKind | undefined, limit = 100): Promise<OpsEventRow[]> {
  // A missing ticker's listing may have been profiled since: on demand, or by
  // a rescreen that admitted it. Read now, not when the gap was recorded.
  return query<OpsEventRow>(
    `SELECT e.id::text, e.kind, e.user_id, e.detail, e.occurrences, e.occurred_at, e.last_seen_at,
            p.membership AS profile_membership
       FROM ops_events e
       LEFT JOIN instruments i
              ON e.kind = 'universe_gap_missing_ticker' AND i.symbol = e.detail->>'symbol'
       LEFT JOIN instrument_profiles p ON p.instrument_id = i.id
      WHERE ($1::text IS NULL OR e.kind = $1)
      ORDER BY e.last_seen_at DESC, e.id DESC
      LIMIT $2`,
    [kind ?? null, limit],
  );
}
