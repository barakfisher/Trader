/**
 * An agent's ledger: its cash, its fills, and the holdings they move (migration 0040).
 *
 * Cash and its movements are written by the database's triggers - a deposit
 * follows `agents.budget_minor`, a trade's debit or credit follows its fill -
 * and `traders_app` holds no write privilege on either table. What this module
 * writes is the fill itself and the holding it changes, both inside the
 * caller's transaction, after `lockAgentCash` (decision D3's row lock). The
 * real portfolio's income, charges and corrections go through
 * `record_primary_cash_movement`, a function that writes only those (D340).
 */

import type { PoolClient } from 'pg';
import type { PrimaryMovementType } from '@traders/shared';

import { query, queryOne } from '../pool.js';

export interface AgentCashRow {
  balance_minor: string;
  currency: string;
  updated_at: Date;
}

/** An agent's cash; null for a primary whose opening cash is not set (D1, D328). */
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

export interface AgentBookRow {
  holdings_cost_minor: string;
  symbol_cost_minor: string;
  held_count: number;
  holds_symbol: boolean;
}

/**
 * What the mandate's size rules read (D171, D299): the agent's holdings at cost,
 * `symbol`'s share of them, and how many instruments it holds. The scan's
 * `trade_review.load_book` reads the same rows. Whole shares (D9) times a per-unit
 * cost in minor units is already an integer; `round` only gives it that type.
 */
export async function getAgentBook(
  userId: string,
  agentId: string,
  symbol: string,
  client?: PoolClient,
): Promise<AgentBookRow> {
  const sql = `SELECT round(coalesce(sum(h.quantity * coalesce(h.cost_basis_minor, 0)), 0))::text AS holdings_cost_minor,
            round(coalesce(sum(h.quantity * coalesce(h.cost_basis_minor, 0)) FILTER (WHERE i.symbol = $3), 0))::text
              AS symbol_cost_minor,
            count(*)::int AS held_count,
            coalesce(bool_or(i.symbol = $3), false) AS holds_symbol
       FROM holdings h JOIN instruments i ON i.id = h.instrument_id
      WHERE h.user_id = $1 AND h.agent_id = $2 AND h.quantity > 0`;
  const params = [userId, agentId, symbol];
  // An aggregate without GROUP BY always answers one row.
  if (client) return (await client.query<AgentBookRow>(sql, params)).rows[0]!;
  return (await queryOne<AgentBookRow>(sql, params))!;
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
 * agent's holdings; the main portfolio's are written by fills and by the
 * holdings routes' corrections (D332).
 */
export async function setAgentHolding(
  client: PoolClient,
  holding: {
    userId: string;
    agentId: string;
    instrumentId: string;
    quantity: bigint;
    /** Null only for a main-portfolio holding entered without a cost (D333). */
    costBasisMinor: bigint | null;
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
      holding.costBasisMinor?.toString() ?? null,
      holding.openedAt,
    ],
  );
}

/** Every kind a cash movement may have; the last three are the real portfolio's only (D340). */
export type CashMovementKind =
  | 'opening_deposit'
  | 'top_up'
  | 'buy'
  | 'sell'
  | 'adjustment'
  | 'withdrawal'
  | 'income'
  | 'charge';

export interface CashActivityRow {
  id: string;
  kind: CashMovementKind;
  amount_minor: string;
  balance_after_minor: string;
  created_at: Date;
  fill_id: string | null;
}

/**
 * Every movement of the agent's cash, newest first, each with the balance it
 * left - one timeline of deposits, top-ups and trades (D31). The running sum
 * is taken in movement order, oldest first; within one instant a deposit
 * precedes a trade.
 */
export function listCashActivity(
  userId: string,
  agentId: string,
  limit: number,
): Promise<CashActivityRow[]> {
  return query<CashActivityRow>(
    `SELECT id, kind, amount_minor::text AS amount_minor, balance_after_minor::text AS balance_after_minor,
            created_at, fill_id
       FROM (
         SELECT m.id, m.kind, m.amount_minor, m.created_at, m.fill_id,
                sum(m.amount_minor) OVER (
                  ORDER BY m.created_at, (m.kind IN ('opening_deposit', 'top_up')) DESC, m.id
                ) AS balance_after_minor,
                (m.kind IN ('opening_deposit', 'top_up')) AS is_deposit
           FROM cash_movements m
          WHERE m.user_id = $1 AND m.agent_id = $2
       ) timeline
      ORDER BY created_at DESC, is_deposit, id DESC
      LIMIT $3`,
    [userId, agentId, limit],
  );
}

/**
 * Every movement of the agent's cash, oldest first, with the balance it left -
 * the whole history, unpaged: an agent's value on a past day is read from it
 * (Stage 3, PR 7). Ordered as `listCashActivity` orders it.
 */
export function listCashTimeline(userId: string, agentId: string): Promise<CashActivityRow[]> {
  return query<CashActivityRow>(
    `SELECT m.id, m.kind, m.amount_minor::text AS amount_minor,
            (sum(m.amount_minor) OVER (
              ORDER BY m.created_at, (m.kind IN ('opening_deposit', 'top_up')) DESC, m.id
            ))::text AS balance_after_minor,
            m.created_at, m.fill_id
       FROM cash_movements m
      WHERE m.user_id = $1 AND m.agent_id = $2
      ORDER BY m.created_at, (m.kind IN ('opening_deposit', 'top_up')) DESC, m.id`,
    [userId, agentId],
  );
}

/** Every fill of the agent, oldest first - the replay performance and the score are built from. */
export function listFillsOldestFirst(userId: string, agentId: string): Promise<FillRow[]> {
  return query<FillRow>(
    `SELECT ${FILL_COLUMNS} FROM fills f JOIN instruments i ON i.id = f.instrument_id
      WHERE f.user_id = $1 AND f.agent_id = $2
      ORDER BY f.created_at, f.id`,
    [userId, agentId],
  );
}

/** Every instrument an active user's agents have traded: the installation's backfill (D238). */
export function listActiveUsersTradedInstruments(): Promise<{ id: string; symbol: string }[]> {
  return query<{ id: string; symbol: string }>(
    `-- agent-blind: shared ingestion fetches every agent's instruments once (§4.1).
     SELECT DISTINCT i.id, i.symbol
       FROM fills f
       JOIN instruments i ON i.id = f.instrument_id
       JOIN users u ON u.id = f.user_id
      WHERE u.status = 'active'
      ORDER BY i.symbol`,
  );
}

/** The fills behind a set of movements, by id. */
export function listFillsByIds(userId: string, agentId: string, ids: string[]): Promise<FillRow[]> {
  if (ids.length === 0) return Promise.resolve([]);
  return query<FillRow>(
    `SELECT ${FILL_COLUMNS} FROM fills f JOIN instruments i ON i.id = f.instrument_id
      WHERE f.user_id = $1 AND f.agent_id = $2 AND f.id = ANY($3::uuid[])`,
    [userId, agentId, ids],
  );
}

/**
 * Add cash: raise the budget by `amountMinor` in one statement, so two top-ups
 * never read the same old budget (D22, D31). The trigger on `agents` records
 * the top-up - or, before the first trade, raises the opening deposit. Null
 * when no active or paused simulated agent matched, or the ceiling would be passed.
 */
export async function topUpAgent(
  userId: string,
  agentId: string,
  amountMinor: number,
  ceilingMinor: number,
): Promise<{ budget_minor: string } | null> {
  return queryOne<{ budget_minor: string }>(
    `UPDATE agents SET budget_minor = budget_minor + $3
      WHERE user_id = $1 AND id = $2 AND NOT is_primary AND state <> 'archived'
        AND budget_minor + $3 <= $4
      RETURNING budget_minor::text AS budget_minor`,
    [userId, agentId, amountMinor, ceilingMinor],
  );
}

/** Every fee the agent's fills paid, in minor units: the "Fees paid" line (2026-10-27 plan). */
export async function sumFeesPaid(userId: string, agentId: string): Promise<number> {
  const row = await queryOne<{ fees: string }>(
    `SELECT coalesce(sum(fee_minor), 0)::text AS fees FROM fills WHERE user_id = $1 AND agent_id = $2`,
    [userId, agentId],
  );
  return Number(row?.fees ?? 0);
}

export interface PrimaryCashRow {
  budget_minor: string | null;
  opening_holdings_cost_minor: string | null;
  balance_minor: string | null;
  currency: string;
  income_minor: string;
  charges_minor: string;
}

/**
 * The real portfolio's cash (D328): its net deposits, what it held when opened,
 * its balance, and the income and charges recorded against it (D340).
 */
export function getPrimaryCash(userId: string, agentId: string): Promise<PrimaryCashRow | null> {
  return queryOne<PrimaryCashRow>(
    `SELECT a.budget_minor::text AS budget_minor,
            a.opening_holdings_cost_minor::text AS opening_holdings_cost_minor,
            c.balance_minor::text AS balance_minor, a.currency,
            coalesce((SELECT sum(m.amount_minor) FROM cash_movements m
                       WHERE m.user_id = a.user_id AND m.agent_id = a.id AND m.kind = 'income'), 0)::text
              AS income_minor,
            coalesce((SELECT -sum(m.amount_minor) FROM cash_movements m
                       WHERE m.user_id = a.user_id AND m.agent_id = a.id AND m.kind = 'charge'), 0)::text
              AS charges_minor
       FROM agents a LEFT JOIN agent_cash c ON c.agent_id = a.id
      WHERE a.user_id = $1 AND a.id = $2 AND a.is_primary`,
    [userId, agentId],
  );
}

/**
 * Open the real portfolio's ledger with the cash the user has at the broker and
 * the cost of what it already holds (D328, D329). The trigger on `agents`
 * creates the cash row and the opening deposit. False when it was already open.
 */
export async function openPrimaryCash(
  userId: string,
  agentId: string,
  cashMinor: number,
  holdingsCostMinor: number,
): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `UPDATE agents SET budget_minor = $3, opening_holdings_cost_minor = $4
      WHERE user_id = $1 AND id = $2 AND is_primary AND budget_minor IS NULL
      RETURNING id`,
    [userId, agentId, cashMinor, holdingsCostMinor],
  );
  return row !== null;
}

export type PrimaryMovementOutcome = 'recorded' | 'unopened' | 'insufficient_cash' | 'over_ceiling';

/**
 * Lock the primary's cash row, then read its budget `FOR NO KEY UPDATE` - the
 * order a fill and a reset take them in (cash row, then the agent row: a
 * fill's foreign-key check, a reset's UPDATE). The other order deadlocked
 * against a trade recorded at the same moment (security review of D340).
 * `NO KEY` still keeps two cash writers apart without blocking a fill's
 * foreign-key check. Null when the cash is not set.
 *
 * An unset budget is read first without a lock: opening takes the agent row
 * before the cash row, and an unopened primary has nothing to lock for.
 */
async function lockPrimary(
  client: PoolClient,
  userId: string,
  agentId: string,
): Promise<{ budget: bigint; balance: bigint } | null> {
  const budgetOf = async (lock: string) => {
    const { rows } = await client.query<{ budget_minor: string | null }>(
      `SELECT budget_minor::text AS budget_minor FROM agents
        WHERE user_id = $1 AND id = $2 AND is_primary ${lock}`,
      [userId, agentId],
    );
    return rows[0]?.budget_minor ?? null;
  };
  if ((await budgetOf('')) === null) return null;
  const balance = await lockAgentCash(client, userId, agentId);
  if (balance === null) return null;
  // Read again under the lock: a reset may have unset it in between.
  const budget = await budgetOf('FOR NO KEY UPDATE');
  return budget === null ? null : { budget: BigInt(budget), balance };
}

/** A movement that does not follow the budget, through the one function allowed to write it (0080). */
async function recordMovement(
  client: PoolClient,
  userId: string,
  agentId: string,
  kind: 'income' | 'charge' | 'adjustment',
  amountMinor: bigint,
): Promise<void> {
  await client.query('SELECT record_primary_cash_movement($1, $2, $3, $4)', [
    userId,
    agentId,
    kind,
    amountMinor.toString(),
  ]);
}

async function withCashKind(client: PoolClient, kind: 'top_up' | 'withdrawal', write: () => Promise<unknown>) {
  await client.query(`SELECT set_config('traders.cash_kind', $1, true)`, [kind]);
  await write();
  await client.query(`SELECT set_config('traders.cash_kind', '', true)`);
}

/**
 * Record one movement of the real portfolio's cash, as its own row (D340).
 * A deposit or a withdrawal moves the net deposits - the budget, which the
 * trigger on `agents` turns into a `top_up` or `withdrawal` row; income and
 * charges are written as rows of their own and leave the deposits alone, so
 * they count as gain or loss. Nothing takes the cash below zero.
 */
export async function recordPrimaryMovement(
  client: PoolClient,
  userId: string,
  agentId: string,
  type: PrimaryMovementType,
  amountMinor: number,
  ceilingMinor: number,
): Promise<PrimaryMovementOutcome> {
  const locked = await lockPrimary(client, userId, agentId);
  if (!locked) return 'unopened';
  const amount = BigInt(amountMinor);
  const outgoing = type === 'withdrawal' || type === 'charge';
  if (outgoing && locked.balance < amount) return 'insufficient_cash';
  if (type === 'deposit' || type === 'withdrawal') {
    if (type === 'deposit' && locked.budget + amount > BigInt(ceilingMinor)) return 'over_ceiling';
    const delta = type === 'deposit' ? amount : -amount;
    await withCashKind(client, type === 'deposit' ? 'top_up' : 'withdrawal', () =>
      client.query(
        `UPDATE agents SET budget_minor = budget_minor + $3 WHERE user_id = $1 AND id = $2 AND is_primary`,
        [userId, agentId, delta.toString()],
      ),
    );
    return 'recorded';
  }
  await recordMovement(client, userId, agentId, type, outgoing ? -amount : amount);
  return 'recorded';
}

export type SetPrimaryCashOutcome = 'set' | 'unopened';

/**
 * Set the real portfolio's cash to what the broker shows, to put a typo right
 * (D330, D342). While the opening deposit is the only movement, the opening
 * amount itself was the typo: the budget moves and the trigger edits it. After
 * anything else has moved the cash, the difference is an `adjustment` row of
 * its own, which leaves the deposits alone - it counts as gain or loss.
 */
export async function setPrimaryCash(
  client: PoolClient,
  userId: string,
  agentId: string,
  balanceMinor: number,
): Promise<SetPrimaryCashOutcome> {
  const locked = await lockPrimary(client, userId, agentId);
  if (!locked) return 'unopened';
  const delta = BigInt(balanceMinor) - locked.balance;
  if (delta === 0n) return 'set';
  const { rows } = await client.query<{ others: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM cash_movements
                     WHERE user_id = $1 AND agent_id = $2 AND kind <> 'opening_deposit') AS others`,
    [userId, agentId],
  );
  if (rows[0]?.others) {
    await recordMovement(client, userId, agentId, 'adjustment', delta);
  } else {
    await client.query(
      `UPDATE agents SET budget_minor = budget_minor + $3 WHERE user_id = $1 AND id = $2 AND is_primary`,
      [userId, agentId, delta.toString()],
    );
  }
  return 'set';
}
