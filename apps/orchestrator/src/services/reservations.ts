/**
 * Cash and shares set aside by approvals waiting to fill (D428, D429).
 *
 * An approval for the open is the user's word that a trade will happen, but
 * until it fills the ledger has not moved: the balance still shows the cash a
 * waiting buy will spend, and the holding still shows the shares a waiting sell
 * will hand over. A trade made by hand in between - or the approval of another
 * proposal - could take them, and the open would then refuse what the user had
 * already approved.
 *
 * So every check of "does this trade fit" reads what is *available*: the
 * balance less the waiting buys, the holding less the waiting sells.
 *
 * - **A buy reserves its cost at the agent's price, and its fee (D429).** The
 *   open may fill up to `MAX_AGENT_DISTANCE_BPS` above that price, so the
 *   reservation can fall short by that much; the fill's own check under the
 *   cash lock is still the last word.
 * - **A sell reserves its shares, and no cash.** Its proceeds are not counted
 *   as available before they arrive.
 * - **A buy funded by its scan's own sells reserves nothing (D429).** It is
 *   queued without a cash check, because its cash arrives when those sells
 *   fill; setting aside cash that is not there would refuse every other buy
 *   and show a negative amount as available. The open's fill decides for it.
 * - **A trade never competes with its own reservation**: the approval being
 *   filled is left out by its proposal id.
 *
 * The scan already sets aside every waiting buy when it sizes a new one (D197);
 * this is the same rule for what the user does by hand.
 */

import { feeMinor, notionalMinor } from '@traders/shared';
import type { PoolClient } from 'pg';

import { listQueuedTrades, type QueuedTradeRow } from '../db/queries.js';

export interface Reservations {
  /** What the waiting buys would take from cash, fees included. */
  cashMinor: bigint;
  /** Shares the waiting sells would hand over, by upper-case symbol. */
  quantityBySymbol: ReadonlyMap<string, bigint>;
}

export const NO_RESERVATIONS: Reservations = { cashMinor: 0n, quantityBySymbol: new Map() };

/** Whole shares of a payload quantity ("3" or "3.000"): an agent trades nothing else (D9). */
function shares(quantity: string): bigint {
  return BigInt(quantity.split('.')[0]!);
}

/** What `rows` set aside, leaving out the approval `exceptProposalId` names. */
export function reservationsOf(rows: readonly QueuedTradeRow[], exceptProposalId?: string | null): Reservations {
  let cashMinor = 0n;
  const quantityBySymbol = new Map<string, bigint>();
  for (const row of rows) {
    if (row.id === exceptProposalId) continue;
    if (row.kind === 'buy') {
      if (row.funded) continue;
      cashMinor += notionalMinor(row.quantity, BigInt(row.price_minor)) + feeMinor(row.quantity);
    } else {
      quantityBySymbol.set(row.symbol, (quantityBySymbol.get(row.symbol) ?? 0n) + shares(row.quantity));
    }
  }
  return { cashMinor, quantityBySymbol };
}

export function reservedQuantity(reservations: Reservations, symbol: string): bigint {
  return reservations.quantityBySymbol.get(symbol.toUpperCase()) ?? 0n;
}

/** What the agent's waiting approvals set aside at `now`. */
export async function agentReservations(
  userId: string,
  agentId: string,
  now: Date,
  { exceptProposalId = null, client }: { exceptProposalId?: string | null; client?: PoolClient } = {},
): Promise<Reservations> {
  return reservationsOf(await listQueuedTrades(userId, agentId, now, client), exceptProposalId);
}
