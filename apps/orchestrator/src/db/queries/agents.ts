import { queryOne } from '../pool.js';

/**
 * The agent that owns a user's real portfolio ("Main portfolio", migration 0036).
 *
 * Every portfolio row carries an `agent_id`, and in Stage 1 of the multi-agent
 * work every row a user writes is the primary's. This is how an edge - an HTTP
 * route, a run handler - learns which id that is; below the edge the id is
 * passed explicitly, never re-derived, so the day a write belongs to another
 * agent changes one call site rather than a query.
 *
 * Not cached: it is one indexed read per request or run, and a cache would
 * outlive a test database that re-creates the same user with a new primary.
 * A missing primary throws rather than returning null, because a write with no
 * owner is the one thing the column exists to prevent.
 */
export async function primaryAgentId(userId: string): Promise<string> {
  const row = await queryOne<{ id: string }>(
    'SELECT id FROM agents WHERE user_id = $1 AND is_primary',
    [userId],
  );
  if (row === null) throw new Error(`user ${userId} has no primary agent`);
  return row.id;
}
