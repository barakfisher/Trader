/**
 * What an agent's waiting approvals set aside (D428): the trades the user has
 * approved for the open and that have not filled yet.
 *
 * Nothing is stored. A reservation is the queue read at the moment of the
 * check, so one that fills, is cancelled, superseded, refused or expires stops
 * counting in the same statement that moves it out of `queued` - there is no
 * second row to release, and so none that can be left behind.
 */

import type { PoolClient } from 'pg';

import { query } from '../pool.js';

export interface QueuedTradeRow {
  id: string;
  kind: 'buy' | 'sell';
  symbol: string;
  /** Whole shares as the payload carries them (guideline 4, D9). */
  quantity: string;
  /** The agent's price, in minor units. */
  price_minor: string;
  /** A buy its scan funded with its own sells (`fundedBy`, D197): its cash has not arrived yet. */
  funded: boolean;
}

/**
 * The agent's approvals still waiting to fill at `now`. A proposal decided by
 * hand, or expired, keeps `open_approval = 'queued'` until the minute tick
 * settles it; it reserves nothing meanwhile, so the state and the expiry are
 * read here too. Inside a fill's transaction the caller passes its `client`,
 * after `lockAgentCash`.
 */
export async function listQueuedTrades(
  userId: string,
  agentId: string,
  now: Date,
  client?: PoolClient,
): Promise<QueuedTradeRow[]> {
  const sql = `SELECT p.id, p.kind, upper(p.payload ->> 'symbol') AS symbol,
            p.payload ->> 'quantity' AS quantity, p.payload ->> 'priceMinor' AS price_minor,
            CASE WHEN jsonb_typeof(p.payload -> 'fundedBy') = 'array'
                 THEN jsonb_array_length(p.payload -> 'fundedBy') > 0 ELSE false END AS funded
       FROM proposals p
      WHERE p.user_id = $1 AND p.agent_id = $2
        AND p.open_approval = 'queued'
        AND p.kind IN ('buy', 'sell')
        AND p.state = 'pending'
        AND p.expires_at > $3
      ORDER BY p.open_approval_at, p.id`;
  const params = [userId, agentId, now];
  if (client) return (await client.query<QueuedTradeRow>(sql, params)).rows;
  return query<QueuedTradeRow>(sql, params);
}
