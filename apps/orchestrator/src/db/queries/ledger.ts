/**
 * An agent's ledger: its cash, its fills, and the holdings they move (migration 0040).
 *
 * Cash and its movements are written by the database's triggers - a deposit
 * follows `agents.budget_minor`, a trade's debit or credit follows its fill -
 * and `traders_app` holds no write privilege on either table. What this module
 * writes is the fill itself and the holding it changes, both inside the
 * caller's transaction, after `lockAgentCash` (decision D3's row lock).
 */

import type { PoolClient } from 'pg';

import { query, queryOne } from '../pool.js';

export interface AgentCashRow {
  balance_minor: string;
  currency: string;
  updated_at: Date;
}

/** A simulated agent's cash; null for the primary, which has none (D1). */
export async function getAgentCash(userId: string, agentId: string): Promise<AgentCashRow | null> {
  return queryOne<AgentCashRow>(
    `SELECT balance_minor::text AS balance_minor, currency, updated_at
       FROM agent_cash WHERE user_id = $1 AND agent_id = $2`,
    [userId, agentId],
  );
}

/** Whether the agent has a fill - after which its budget can rise but not fall (D22). */
export async function agentHasTraded(userId: string, agentId: string): Promise<boolean> {
  const row = await queryOne<{ traded: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM fills WHERE user_id = $1 AND agent_id = $2) AS traded`,
    [userId, agentId],
  );
  return row?.traded ?? false;
}

/** How many shares of an instrument the agent holds, as stored; null when none. */
export async function getAgentHoldingQuantity(
  userId: string,
  agentId: string,
  instrumentId: string,
): Promise<string | null> {
  const row = await queryOne<{ quantity: string }>(
    `SELECT quantity::text AS quantity FROM holdings
      WHERE user_id = $1 AND agent_id = $2 AND instrument_id = $3`,
    [userId, agentId, instrumentId],
  );
  return row?.quantity ?? null;
}

export interface FillRow {
  id: string;
  agent_id: string;
  instrument_id: string;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: string;
  price_minor: string;
  notional_minor: string;
  fee_minor: string;
  currency: string;
  price_source: 'quote' | 'user';
  quote_as_of: Date | null;
  quote_delay_seconds: number | null;
  source: 'manual_user_override' | 'agent';
  proposal_id: string | null;
  idempotency_key: string;
  created_at: Date;
}

const FILL_COLUMNS = `f.id, f.agent_id, f.instrument_id, i.symbol, f.side, f.quantity::text AS quantity,
  f.price_minor::text AS price_minor, f.notional_minor::text AS notional_minor,
  f.fee_minor::text AS fee_minor, f.currency, f.price_source, f.quote_as_of, f.quote_delay_seconds,
  f.source, f.proposal_id, f.idempotency_key, f.created_at`;

/** The fill an idempotency key already produced, if any - a repeated submit returns it. */
export async function findFillByKey(
  userId: string,
  agentId: string,
  idempotencyKey: string,
  client?: PoolClient,
): Promise<FillRow | null> {
  const sql = `SELECT ${FILL_COLUMNS} FROM fills f JOIN instruments i ON i.id = f.instrument_id
     WHERE f.user_id = $1 AND f.agent_id = $2 AND f.idempotency_key = $3`;
  const params = [userId, agentId, idempotencyKey];
  if (client) return (await client.query<FillRow>(sql, params)).rows[0] ?? null;
  return queryOne<FillRow>(sql, params);
}

/** An agent's fills, newest first. */
export function listFills(userId: string, agentId: string, limit: number): Promise<FillRow[]> {
  return query<FillRow>(
    `SELECT ${FILL_COLUMNS} FROM fills f JOIN instruments i ON i.id = f.instrument_id
      WHERE f.user_id = $1 AND f.agent_id = $2
      ORDER BY f.created_at DESC, f.id DESC
      LIMIT $3`,
    [userId, agentId, limit],
  );
}

/**
 * Lock the agent's cash row for the rest of the transaction and read it. Every
 * trade takes this lock first, so two trades on one agent - or a trade and a
 * budget edit - run one after the other. Null when the agent has no cash row.
 */
export async function lockAgentCash(
  client: PoolClient,
  userId: string,
  agentId: string,
): Promise<bigint | null> {
  const { rows } = await client.query<{ balance_minor: string }>(
    `SELECT balance_minor::text AS balance_minor FROM agent_cash
      WHERE user_id = $1 AND agent_id = $2 FOR UPDATE`,
    [userId, agentId],
  );
  return rows[0] ? BigInt(rows[0].balance_minor) : null;
}

export interface LockedHolding {
  quantity: string;
  cost_basis_minor: string | null;
}

/** The agent's holding of one instrument, locked; null when it holds none. */
export async function lockAgentHolding(
  client: PoolClient,
  userId: string,
  agentId: string,
  instrumentId: string,
): Promise<LockedHolding | null> {
  const { rows } = await client.query<LockedHolding>(
    `SELECT quantity::text AS quantity, cost_basis_minor::text AS cost_basis_minor
       FROM holdings WHERE user_id = $1 AND agent_id = $2 AND instrument_id = $3 FOR UPDATE`,
    [userId, agentId, instrumentId],
  );
  return rows[0] ?? null;
}

export interface FillToInsert {
  userId: string;
  agentId: string;
  instrumentId: string;
  side: 'buy' | 'sell';
  quantity: bigint;
  priceMinor: bigint;
  notionalMinor: bigint;
  feeMinor: bigint;
  priceSource: 'quote' | 'user';
  quoteAsOf: string | null;
  quoteDelaySeconds: number | null;
  source: 'manual_user_override' | 'agent';
  proposalId: string | null;
  idempotencyKey: string;
}

/** Write a fill; its cash movement and the new balance follow by trigger. Returns its id. */
export async function insertFill(client: PoolClient, fill: FillToInsert): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO fills (user_id, agent_id, instrument_id, side, quantity, price_minor, notional_minor,
                        fee_minor, price_source, quote_as_of, quote_delay_seconds, source,
                        proposal_id, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING id`,
    [
      fill.userId,
      fill.agentId,
      fill.instrumentId,
      fill.side,
      fill.quantity.toString(),
      fill.priceMinor.toString(),
      fill.notionalMinor.toString(),
      fill.feeMinor.toString(),
      fill.priceSource,
      fill.quoteAsOf,
      fill.quoteDelaySeconds,
      fill.source,
      fill.proposalId,
      fill.idempotencyKey,
    ],
  );
  return rows[0]!.id;
}

/**
 * Set the agent's holding of an instrument after a fill: quantity and cost per
 * unit, or remove the row when nothing is left. Only fills reach a simulated
 * agent's holdings - the holdings routes write the primary's alone.
 */
export async function setAgentHolding(
  client: PoolClient,
  holding: {
    userId: string;
    agentId: string;
    instrumentId: string;
    quantity: bigint;
    costBasisMinor: bigint;
    openedAt: string;
  },
): Promise<void> {
  if (holding.quantity === 0n) {
    await client.query(
      `DELETE FROM holdings WHERE user_id = $1 AND agent_id = $2 AND instrument_id = $3`,
      [holding.userId, holding.agentId, holding.instrumentId],
    );
    return;
  }
  await client.query(
    `INSERT INTO holdings (user_id, agent_id, instrument_id, quantity, cost_basis_minor, currency, opened_at)
     VALUES ($1, $2, $3, $4, $5, 'USD', $6)
     ON CONFLICT (agent_id, instrument_id) DO UPDATE SET
       quantity = EXCLUDED.quantity,
       cost_basis_minor = EXCLUDED.cost_basis_minor,
       updated_at = now()`,
    [
      holding.userId,
      holding.agentId,
      holding.instrumentId,
      holding.quantity.toString(),
      holding.costBasisMinor.toString(),
      holding.openedAt,
    ],
  );
}
