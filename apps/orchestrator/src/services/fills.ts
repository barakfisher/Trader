/**
 * How a trade becomes a fill: the one path every trade takes (Stage 3, PR 4).
 *
 * A manual trade (D21) runs through `executeFill` today; Stage 4's approval of
 * an agent's proposal will run through the same function (D26), so every rule
 * here is proven by hand before a model can propose through it:
 *
 * - **Who may trade.** A simulated agent that is active or paused; never the
 *   primary (D1), never an archived agent (D30).
 * - **What.** A USD instrument in the universe (D7, D8) on an exchange with a
 *   calendar (D25), in whole shares (D9).
 * - **At what price.** Either the live quote - the exchange open, the quote at
 *   most `MAX_QUOTE_AGE_MS` old and not stale (D28), and within
 *   `DEFAULT_RANGE_BPS` of the price the user was shown (D3, D27) - or a price
 *   the user typed, recorded as such (D21), with a warning when it is far from
 *   the last known price but never a refusal (D29).
 * - **Paid for.** The fee of D6, the cash re-checked under the agent's cash-row
 *   lock in the same transaction as the fill; a trade that does not fit is
 *   refused, never resized (§5.1). The database refuses a negative balance too.
 * - **Recorded once.** An idempotency key per agent: a repeated submit returns
 *   the fill it already made (guideline 8).
 *
 * The holding moves in the same transaction: average cost per unit on a buy,
 * rounded once; unchanged on a sell; the row removed at zero.
 */

import {
  feeMinor,
  notionalMinor,
  type FillView,
  type TradePreview,
  type TradeResult,
  type TradeSide,
  type TradeWarning,
} from '@traders/shared';
import { AiServiceError, type AiClient, type Quote } from '@traders/shared/ai';
import type { PoolClient } from 'pg';

import {
  findFillByKey,
  findTradableInstrument,
  getAgentCash,
  getAgentHoldingQuantity,
  insertFill,
  lockAgentCash,
  lockAgentHolding,
  setAgentHolding,
  transaction,
  type AgentRow,
  type FillRow,
  type TradableInstrumentRow,
} from '../db/queries.js';
import { conflict, notFound, unprocessable, upstreamFailure } from '../http/errors.js';
import { localDate } from './snapshot.js';

/** D28: Yahoo's 15-minute delay plus one cache cycle. Older than this, a quote is refused. */
export const MAX_QUOTE_AGE_MS = 30 * 60 * 1000;
/** D3: the live price may differ from the one shown by at most this, either way. */
export const DEFAULT_RANGE_BPS = 50n;
/** D29: a typed price this far from the last known one is flagged, not refused. */
export const TYPED_PRICE_WARNING_BPS = 500n;
export const BPS = 10_000n;
/** The most shares one trade may name: ten digits, far beyond any budget's reach. */
const QUANTITY_PATTERN = /^[1-9]\d{0,9}$/;
const PRICE_PATTERN = /^\d+(\.\d{1,2})?$/;
/** The highest price a user may type: $1,000,000,000 a share, the budget ceiling. */
export const MAX_TYPED_PRICE_MINOR = 100_000_000_000n;

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

export interface TradeContext {
  ai: AiClient;
  requestId?: string;
  /** The user's timezone: a new holding's `opened_at` is their today. */
  timezone: string;
  now?: () => Date;
}

/** How the price is set. `shownPriceMinor` is null only for a preview. */
export type TradePrice =
  | { source: 'quote'; shownPriceMinor: bigint | null }
  | { source: 'user'; priceMinor: bigint };

export interface TradeRequest {
  userId: string;
  agent: AgentRow;
  symbol: string;
  side: TradeSide;
  quantity: string;
  price: TradePrice;
  source: 'manual_user_override' | 'agent';
  proposalId?: string | null;
  idempotencyKey: string;
}

/** `true` when `live` is within `bps` of `shown`, either way (D3). Integer arithmetic only. */
export function withinRange(shown: bigint, live: bigint, bps: bigint = DEFAULT_RANGE_BPS): boolean {
  const distance = live > shown ? live - shown : shown - live;
  return distance * BPS <= shown * bps;
}

/** `true` when a quote may price a fill at `now` (D28). */
export function quoteIsFresh(quote: Pick<Quote, 'as_of' | 'stale'>, now: Date): boolean {
  if (quote.stale) return false;
  const observed = Date.parse(quote.as_of);
  return Number.isFinite(observed) && now.getTime() - observed <= MAX_QUOTE_AGE_MS;
}

/** Cost per unit after buying `quantity` at `priceMinor` onto a holding; rounded half up, once. */
export function averageCostMinor(
  heldQuantity: bigint,
  heldCostMinor: bigint,
  quantity: bigint,
  priceMinor: bigint,
): bigint {
  const total = heldQuantity + quantity;
  return (heldQuantity * heldCostMinor + quantity * priceMinor + total / 2n) / total;
}

/** The signed basis-point distance of `price` from `reference`, rounded toward zero. */
export function deviationBps(price: bigint, reference: bigint): bigint {
  return ((price - reference) * BPS) / reference;
}

/** A whole number of shares as the wire carries it (guideline 4, D9). */
export function parseQuantity(text: string): bigint {
  const trimmed = text.trim();
  if (!QUANTITY_PATTERN.test(trimmed)) {
    throw unprocessable('invalid_quantity', 'a trade is a whole, positive number of shares');
  }
  return BigInt(trimmed);
}

/** A typed price in dollars, at most two decimals, into minor units - refused, not rounded. */
export function parseTypedPrice(text: string): bigint {
  const trimmed = text.trim();
  if (!PRICE_PATTERN.test(trimmed)) {
    throw unprocessable('invalid_price', 'a price is an amount in dollars, at most two decimal places');
  }
  const [whole, cents = ''] = trimmed.split('.');
  const minor = BigInt(whole!) * 100n + BigInt(cents.padEnd(2, '0'));
  if (minor <= 0n || minor > MAX_TYPED_PRICE_MINOR) {
    throw unprocessable('invalid_price', 'a price must be more than $0 and at most $1,000,000,000');
  }
  return minor;
}

/** A whole-share holding quantity as stored (`numeric(38,18)` text), as a bigint. */
function wholeShares(stored: string): bigint {
  const [whole, fraction = ''] = stored.split('.');
  if (/[1-9]/.test(fraction)) {
    throw new Error(`a simulated holding is whole shares, found ${stored}`);
  }
  return BigInt(whole!);
}

/** Bigint minor units to a JSON number; every ledger amount is far inside the safe range. */
function toNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`amount ${value} exceeds the safe integer range`);
  }
  return Number(value);
}

/** The agent may be traded: simulated (D1), and not archived (D30). */
export function assertTradableAgent(agent: AgentRow): void {
  if (agent.is_primary) {
    throw conflict(
      'primary_agent_is_passive',
      'the real portfolio never trades: trades go into a simulated agent',
    );
  }
  if (agent.state === 'archived') {
    throw conflict('agent_archived', 'an archived agent is read-only history; restore it to trade');
  }
}

/** The instrument a trade names, if it may be traded at all (D7, D8). */
export async function resolveTradable(symbol: string): Promise<TradableInstrumentRow> {
  const instrument = await findTradableInstrument(symbol);
  if (!instrument) throw notFound(`no instrument ${symbol.trim().toUpperCase()} is known`);
  if (instrument.membership === null || instrument.membership === 'dropped') {
    throw unprocessable('not_tradable', `${instrument.symbol} is not in the tradable universe`, {
      reason: 'outside_universe',
    });
  }
  if (instrument.currency.toUpperCase() !== 'USD') {
    throw unprocessable('not_tradable', `${instrument.symbol} is not priced in USD`, {
      reason: 'not_usd',
    });
  }
  return instrument;
}

function aiFailure(error: unknown, what: string): never {
  if (error instanceof AiServiceError) throw upstreamFailure(error.status, what);
  throw error;
}

/** A live quote that may price a fill now: the exchange open (D21, D25), the quote fresh (D28). */
async function liveQuote(instrument: TradableInstrumentRow, context: TradeContext): Promise<Quote> {
  const now = (context.now ?? (() => new Date()))();
  let calendar;
  try {
    calendar = await context.ai.marketCalendar(instrument.exchange ?? '', context.requestId);
  } catch (error) {
    if (error instanceof AiServiceError && error.status === 422) {
      throw unprocessable('not_tradable', `${instrument.symbol} trades where no calendar is held`, {
        reason: 'no_calendar',
      });
    }
    aiFailure(error, 'The exchange calendar could not be read.');
  }
  if (!calendar.is_open) {
    throw unprocessable(
      'market_closed',
      'the exchange is closed: trade at the live price when it opens, or type a price',
      { nextOpen: calendar.next_open },
    );
  }
  let response;
  try {
    response = await context.ai.quotes([instrument.symbol], context.requestId, {
      [instrument.symbol]: { asset_class: instrument.asset_class, exchange: instrument.exchange },
    });
  } catch (error) {
    aiFailure(error, 'The quote could not be read.');
  }
  const quote = response.quotes.find((q) => q.symbol.toUpperCase() === instrument.symbol);
  if (!quote || quote.currency.toUpperCase() !== 'USD') {
    throw unprocessable('quote_unavailable', `no price is available for ${instrument.symbol}: try again or type a price`);
  }
  if (!quoteIsFresh(quote, now)) {
    throw unprocessable(
      'quote_too_old',
      `the latest price for ${instrument.symbol} is too old to trade at: try again or type a price`,
      { quoteAsOf: quote.as_of },
    );
  }
  return quote;
}

/** D29: how far a typed price sits from the last known one, when that is far. Never blocks. */
async function typedPriceWarnings(
  instrument: TradableInstrumentRow,
  priceMinor: bigint,
  context: TradeContext,
): Promise<TradeWarning[]> {
  try {
    const response = await context.ai.quotes([instrument.symbol], context.requestId, {
      [instrument.symbol]: { asset_class: instrument.asset_class, exchange: instrument.exchange },
    });
    const reference = response.quotes.find((q) => q.symbol.toUpperCase() === instrument.symbol);
    if (!reference || reference.price_minor <= 0) return [];
    const deviation = deviationBps(priceMinor, BigInt(reference.price_minor));
    const magnitude = deviation < 0n ? -deviation : deviation;
    if (magnitude < TYPED_PRICE_WARNING_BPS) return [];
    return [
      {
        kind: 'typed_price_far_from_quote',
        deviationBps: toNumber(deviation),
        referencePriceMinor: reference.price_minor,
        referenceAsOf: reference.as_of,
      },
    ];
  } catch {
    // A warning is a courtesy: with no reference price there is nothing to warn about.
    return [];
  }
}

interface Priced {
  priceMinor: bigint;
  quote: Quote | null;
}

async function priceOf(
  instrument: TradableInstrumentRow,
  price: TradePrice,
  context: TradeContext,
): Promise<Priced> {
  if (price.source === 'user') return { priceMinor: price.priceMinor, quote: null };
  const quote = await liveQuote(instrument, context);
  const live = BigInt(quote.price_minor);
  if (price.shownPriceMinor !== null && !withinRange(price.shownPriceMinor, live)) {
    throw conflict('price_moved', 'the price moved more than 0.5% since it was shown: review the new price', {
      shownPriceMinor: toNumber(price.shownPriceMinor),
      livePriceMinor: quote.price_minor,
      quoteAsOf: quote.as_of,
    });
  }
  return { priceMinor: live, quote };
}

function cashChange(side: TradeSide, notional: bigint, fee: bigint): bigint {
  return side === 'buy' ? -(notional + fee) : notional - fee;
}

/** Refuse what would not fit: cash below zero, or selling more than is held (§5.1). */
function assertFits(side: TradeSide, cash: bigint, change: bigint, held: bigint, quantity: bigint): void {
  if (side === 'sell' && quantity > held) {
    throw unprocessable('insufficient_holding', `the agent holds ${held} shares, fewer than ${quantity}`, {
      heldQuantity: held.toString(),
    });
  }
  if (cash + change < 0n) {
    throw unprocessable('insufficient_cash', 'the agent does not have the cash for this trade and its fee', {
      cashMinor: toNumber(cash),
      requiredMinor: toNumber(-change),
    });
  }
}

/** What the trade would do, computed exactly as `executeFill` would. Writes nothing. */
export async function previewTrade(request: TradeRequest, context: TradeContext): Promise<TradePreview> {
  assertTradableAgent(request.agent);
  const instrument = await resolveTradable(request.symbol);
  const quantity = parseQuantity(request.quantity);
  const { priceMinor, quote } = await priceOf(instrument, request.price, context);
  const notional = notionalMinor(quantity.toString(), priceMinor);
  const fee = feeMinor(notional);
  const change = cashChange(request.side, notional, fee);
  const cashRow = await getAgentCash(request.userId, request.agent.id);
  if (!cashRow) throw conflict('agent_has_no_cash', 'this agent has no cash account');
  const cash = BigInt(cashRow.balance_minor);
  const held = wholeShares(
    (await getAgentHoldingQuantity(request.userId, request.agent.id, instrument.id)) ?? '0',
  );
  assertFits(request.side, cash, change, held, quantity);
  const warnings =
    request.price.source === 'user' ? await typedPriceWarnings(instrument, priceMinor, context) : [];
  return {
    symbol: instrument.symbol,
    name: instrument.name,
    side: request.side,
    quantity: quantity.toString(),
    priceSource: request.price.source,
    priceMinor: toNumber(priceMinor),
    quoteAsOf: quote?.as_of ?? null,
    quoteDelaySeconds: quote?.delay_seconds ?? null,
    notionalMinor: toNumber(notional),
    feeMinor: toNumber(fee),
    cashChangeMinor: toNumber(change),
    cashMinor: toNumber(cash),
    cashAfterMinor: toNumber(cash + change),
    heldQuantity: held.toString(),
    heldAfterQuantity: (request.side === 'buy' ? held + quantity : held - quantity).toString(),
    currency: 'USD',
    warnings,
  };
}

export function toFillView(row: FillRow): FillView {
  return {
    id: row.id,
    symbol: row.symbol,
    side: row.side,
    quantity: wholeShares(row.quantity).toString(),
    priceMinor: toNumber(BigInt(row.price_minor)),
    notionalMinor: toNumber(BigInt(row.notional_minor)),
    feeMinor: toNumber(BigInt(row.fee_minor)),
    currency: row.currency,
    priceSource: row.price_source,
    quoteAsOf: row.quote_as_of ? row.quote_as_of.toISOString() : null,
    quoteDelaySeconds: row.quote_delay_seconds,
    source: row.source,
    createdAt: row.created_at.toISOString(),
  };
}

async function replay(request: TradeRequest): Promise<TradeResult | null> {
  const existing = await findFillByKey(request.userId, request.agent.id, request.idempotencyKey);
  if (!existing) return null;
  const cash = await getAgentCash(request.userId, request.agent.id);
  const held = await getAgentHoldingQuantity(request.userId, request.agent.id, existing.instrument_id);
  return {
    fill: toFillView(existing),
    created: false,
    cashMinor: toNumber(BigInt(cash?.balance_minor ?? '0')),
    heldQuantity: wholeShares(held ?? '0').toString(),
  };
}

/**
 * What the caller writes in the fill's own transaction, after the fill and the
 * holding: the approval of the proposal it fills (D11, D47). Throwing rolls the
 * fill back with it, so neither can be committed alone. Not run on a replay.
 */
export type InFillTransaction = (client: PoolClient, fill: FillView) => Promise<void>;

/**
 * Record a trade: every check, then the fill and the holding in one transaction
 * under the agent's cash-row lock. The single path a fill is written by.
 */
export async function executeFill(
  request: TradeRequest,
  context: TradeContext,
  inTransaction?: InFillTransaction,
): Promise<TradeResult> {
  assertTradableAgent(request.agent);
  const replayed = await replay(request);
  if (replayed) return replayed;

  const instrument = await resolveTradable(request.symbol);
  const quantity = parseQuantity(request.quantity);
  if (request.price.source === 'quote' && request.price.shownPriceMinor === null) {
    throw unprocessable('shown_price_required', 'a trade at the live price confirms the price it was shown');
  }
  const { priceMinor, quote } = await priceOf(instrument, request.price, context);
  const notional = notionalMinor(quantity.toString(), priceMinor);
  const fee = feeMinor(notional);
  const change = cashChange(request.side, notional, fee);
  const now = (context.now ?? (() => new Date()))();

  try {
    return await transaction(async (client) => {
      const cash = await lockAgentCash(client, request.userId, request.agent.id);
      if (cash === null) throw conflict('agent_has_no_cash', 'this agent has no cash account');
      // Under the lock, so a racing submit of the same key sees the first one's fill.
      const raced = await findFillByKey(request.userId, request.agent.id, request.idempotencyKey, client);
      if (raced) {
        return {
          fill: toFillView(raced),
          created: false,
          cashMinor: toNumber(cash),
          heldQuantity: wholeShares(
            (await lockAgentHolding(client, request.userId, request.agent.id, raced.instrument_id))
              ?.quantity ?? '0',
          ).toString(),
        };
      }
      const holding = await lockAgentHolding(client, request.userId, request.agent.id, instrument.id);
      const held = wholeShares(holding?.quantity ?? '0');
      assertFits(request.side, cash, change, held, quantity);

      const fillId = await insertFill(client, {
        userId: request.userId,
        agentId: request.agent.id,
        instrumentId: instrument.id,
        side: request.side,
        quantity,
        priceMinor,
        notionalMinor: notional,
        feeMinor: fee,
        priceSource: request.price.source,
        quoteAsOf: quote?.as_of ?? null,
        quoteDelaySeconds: quote?.delay_seconds ?? null,
        source: request.source,
        proposalId: request.proposalId ?? null,
        idempotencyKey: request.idempotencyKey,
      });

      const heldAfter = request.side === 'buy' ? held + quantity : held - quantity;
      const heldCost = BigInt(holding?.cost_basis_minor ?? '0');
      await setAgentHolding(client, {
        userId: request.userId,
        agentId: request.agent.id,
        instrumentId: instrument.id,
        quantity: heldAfter,
        costBasisMinor:
          request.side === 'buy' ? averageCostMinor(held, heldCost, quantity, priceMinor) : heldCost,
        openedAt: localDate(context.timezone, now),
      });

      const fill = await findFillByKey(request.userId, request.agent.id, request.idempotencyKey, client);
      if (!fill || fill.id !== fillId) throw new Error('the fill just written could not be read back');
      await inTransaction?.(client, toFillView(fill));
      return {
        fill: toFillView(fill),
        created: true,
        cashMinor: toNumber(cash + change),
        heldQuantity: heldAfter.toString(),
      };
    });
  } catch (error) {
    const pg = error as { code?: string; constraint?: string; message?: string };
    // Two submits of one key in the same instant: the second meets the first's fill.
    if (pg.code === UNIQUE_VIOLATION && pg.constraint === 'fills_agent_idempotency_key') {
      const again = await replay(request);
      if (again) return again;
    }
    // The database's own refusal, should the checks above ever disagree with it.
    if (pg.code === CHECK_VIOLATION && (pg.message ?? '').includes('balance_minor')) {
      throw unprocessable('insufficient_cash', 'the agent does not have the cash for this trade and its fee');
    }
    throw error;
  }
}
