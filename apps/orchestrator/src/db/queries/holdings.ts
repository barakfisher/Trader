import type { PoolClient } from 'pg';
import type { AssetClass } from '@traders/shared';
import { query, queryOne } from '../pool.js';

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

export function listHoldings(userId: string, agentId: string): Promise<HoldingRow[]> {
  return query<HoldingRow>(
    `SELECT h.id, h.user_id, h.instrument_id, h.quantity::text AS quantity,
            h.cost_basis_minor::text AS cost_basis_minor, h.currency, h.opened_at, h.notes,
            i.symbol, i.name, i.asset_class, i.exchange, i.currency AS instrument_currency
       FROM holdings h
       JOIN instruments i ON i.id = h.instrument_id
      WHERE h.user_id = $1 AND h.agent_id = $2
      ORDER BY i.symbol`,
    [userId, agentId],
  );
}

export function getHolding(
  userId: string,
  agentId: string,
  holdingId: string,
): Promise<HoldingRow | null> {
  return queryOne<HoldingRow>(
    `SELECT h.id, h.user_id, h.instrument_id, h.quantity::text AS quantity,
            h.cost_basis_minor::text AS cost_basis_minor, h.currency, h.opened_at, h.notes,
            i.symbol, i.name, i.asset_class, i.exchange, i.currency AS instrument_currency
       FROM holdings h
       JOIN instruments i ON i.id = h.instrument_id
      WHERE h.user_id = $1 AND h.agent_id = $2 AND h.id = $3`,
    [userId, agentId, holdingId],
  );
}

export interface UpsertHoldingInput {
  userId: string;
  /** The agent that owns the row (migration 0036); the primary's in Stage 1. */
  agentId: string;
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
    INSERT INTO holdings (user_id, agent_id, instrument_id, quantity, cost_basis_minor, currency, opened_at, notes)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
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
    input.agentId,
    input.instrumentId,
    input.quantity,
    input.costBasisMinor,
    input.currency.toUpperCase(),
    input.openedAt,
    input.notes,
  ];
  if (client) {
    return client.query<{ id: string; inserted: boolean }>(sql, params).then((r) => r.rows[0]!);
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
  agentId: string,
  holdingId: string,
  patch: UpdateHoldingPatch,
): Promise<HoldingRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [userId, agentId, holdingId];
  const push = (fragment: string, value: unknown) => {
    params.push(value);
    sets.push(`${fragment} = $${params.length}`);
  };
  if (patch.quantity !== undefined) push('quantity', patch.quantity);
  if (patch.costBasisMinor !== undefined) push('cost_basis_minor', patch.costBasisMinor);
  if (patch.currency !== undefined) push('currency', patch.currency.toUpperCase());
  if (patch.openedAt !== undefined) push('opened_at', patch.openedAt);
  if (patch.notes !== undefined) push('notes', patch.notes);
  if (sets.length === 0) return getHolding(userId, agentId, holdingId);

  const updated = await queryOne<{ id: string }>(
    `UPDATE holdings SET ${sets.join(', ')}, updated_at = now()
      WHERE user_id = $1 AND agent_id = $2 AND id = $3 RETURNING id`,
    params,
  );
  return updated ? getHolding(userId, agentId, holdingId) : null;
}

export async function deleteHolding(
  userId: string,
  agentId: string,
  holdingId: string,
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    'DELETE FROM holdings WHERE user_id = $1 AND agent_id = $2 AND id = $3 RETURNING id',
    [userId, agentId, holdingId],
  );
  return rows.length > 0;
}

export async function deleteAllHoldings(
  userId: string,
  agentId: string,
  client?: PoolClient,
): Promise<number> {
  const sql = 'DELETE FROM holdings WHERE user_id = $1 AND agent_id = $2';
  if (client) {
    const result = await client.query(sql, [userId, agentId]);
    return result.rowCount ?? 0;
  }
  const rows = await query<{ id: string }>(`${sql} RETURNING id`, [userId, agentId]);
  return rows.length;
}
