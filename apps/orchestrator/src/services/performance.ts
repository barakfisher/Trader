/**
 * A simulated agent's performance (multi-agent Stage 3, PR 7; spec §5.4, D24,
 * D36-D42): its value at every trading day's close, the same deposits held in
 * SPY instead, and the 30/60/90-day score of the agent's own decisions.
 *
 * Everything is computed, nothing is stored (D36). The ledger is append-only
 * and daily closes are kept, so an agent's value on any past session is its
 * cash after the last movement before that close plus each holding at that
 * day's close - recomputable, without the gaps a nightly snapshot has whenever
 * the machine was off, and on the same closes the benchmark uses.
 *
 * The shadow benchmark (D24, D37, D38): each deposit buys SPY at the first
 * session close at or after it - a deposit after the close, or on a closed day,
 * waits for the next one - in fractional shares and without fees. Both
 * returns are P&L over deposits, so a top-up is never mistaken for a gain.
 * The benchmark paying no fees is recorded debt: the user will add them.
 *
 * The score (D39-D41) replays only `source = 'agent'` fills into the agent's
 * own book, as if the user had never traded by hand: a sell is scored against
 * the shares the agent itself bought, with its own fee and its share of the
 * buy fees, and is a win when that is above zero. Each sell counts once, in
 * the windows its date falls in; unrealised P&L is one figure for now.
 *
 * Money is `bigint` minor units throughout and rounds once, half up, when a
 * share of a total is taken (guideline 3). Any missing price makes the figure
 * that needed it null - unavailable, never partial (§5.4, decision 111).
 */

import type {
  AgentPerformanceResponse,
  AgentScore,
  PerformanceComparison,
  PerformancePoint,
  ScoreWindow,
} from '@traders/shared';

import type { CashActivityRow, FillRow } from '../db/queries.js';

/** The benchmark every agent is compared with (D24). */
export const BENCHMARK_SYMBOL = 'SPY';

/** The score's rolling windows, in days (§5.4). */
export const SCORE_WINDOWS_DAYS = [30, 60, 90] as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const DEPOSIT_KINDS = new Set(['opening_deposit', 'top_up']);

/** A session as the calendar answers it: its New York date and closing instant. */
export interface SessionClose {
  day: string;
  closesAt: Date;
}

/** Stored daily closes, by instrument id, then by day (YYYY-MM-DD). */
export type ClosesByInstrument = Map<string, Map<string, bigint>>;

/** Round `numerator / denominator` half up; both non-negative or the sign carried by the numerator. */
export function divideRounded(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('divideRounded needs a positive denominator');
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  const rounded = (magnitude * 2n + denominator) / (denominator * 2n);
  return negative ? -rounded : rounded;
}

/** A stored quantity (`numeric(38, 18)` as text) as whole shares (D9). Refuses a fraction. */
export function wholeShares(text: string): bigint {
  const [whole = '0', fraction = ''] = text.trim().split('.');
  if (/[1-9]/.test(fraction)) throw new Error(`a fill quantity is whole shares, not ${text}`);
  return BigInt(whole);
}

function pct(numerator: bigint, denominator: bigint): number | null {
  return denominator > 0n ? (Number(numerator) / Number(denominator)) * 100 : null;
}

function toNumber(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}

interface Deposit {
  at: Date;
  amountMinor: bigint;
}

function depositsOf(movements: CashActivityRow[]): Deposit[] {
  return movements
    .filter((row) => DEPOSIT_KINDS.has(row.kind))
    .map((row) => ({ at: new Date(row.created_at), amountMinor: BigInt(row.amount_minor) }));
}

/** The first session whose close is at or after `at` (D37); null while it has not happened. */
export function benchmarkSessionFor(at: Date, sessions: SessionClose[]): SessionClose | null {
  return sessions.find((session) => session.closesAt.getTime() >= at.getTime()) ?? null;
}

/** Cash after the last movement made by `at`, from the timeline's running balance. */
function cashAt(movements: CashActivityRow[], at: Date): bigint | null {
  let balance: bigint | null = null;
  for (const row of movements) {
    if (new Date(row.created_at).getTime() > at.getTime()) break;
    balance = BigInt(row.balance_after_minor);
  }
  return balance;
}

/** Shares held of each instrument after every fill made by `at`. */
function holdingsAt(fills: FillRow[], at: Date): Map<string, bigint> {
  const held = new Map<string, bigint>();
  for (const fill of fills) {
    if (new Date(fill.created_at).getTime() > at.getTime()) break;
    const change = wholeShares(fill.quantity) * (fill.side === 'buy' ? 1n : -1n);
    held.set(fill.instrument_id, (held.get(fill.instrument_id) ?? 0n) + change);
  }
  return held;
}

function netWorthOn(
  session: SessionClose,
  movements: CashActivityRow[],
  fills: FillRow[],
  closes: ClosesByInstrument,
): bigint | null {
  const cash = cashAt(movements, session.closesAt);
  if (cash === null) return null;
  let value = cash;
  for (const [instrumentId, quantity] of holdingsAt(fills, session.closesAt)) {
    if (quantity === 0n) continue;
    const close = closes.get(instrumentId)?.get(session.day);
    if (close === undefined) return null;
    value += quantity * close;
  }
  return value;
}

/**
 * What the deposits made by this session's close are worth in SPY at it: each
 * bought `amount / close(buy day)` shares, so its value is `amount × close(day)
 * / close(buy day)`. Summed as one exact fraction and rounded once.
 */
function benchmarkOn(
  session: SessionClose,
  deposits: Deposit[],
  sessions: SessionClose[],
  benchmarkCloses: Map<string, bigint> | undefined,
): bigint | null {
  const closeToday = benchmarkCloses?.get(session.day);
  if (closeToday === undefined) return null;
  let numerator = 0n;
  let denominator = 1n;
  for (const deposit of deposits) {
    if (deposit.at.getTime() > session.closesAt.getTime()) continue;
    const bought = benchmarkSessionFor(deposit.at, sessions);
    const closeThen = bought ? benchmarkCloses?.get(bought.day) : undefined;
    if (closeThen === undefined || closeThen <= 0n) return null;
    numerator = numerator * closeThen + deposit.amountMinor * closeToday * denominator;
    denominator *= closeThen;
  }
  return divideRounded(numerator, denominator);
}

function depositedBy(deposits: Deposit[], at: Date): bigint {
  return deposits
    .filter((deposit) => deposit.at.getTime() <= at.getTime())
    .reduce((sum, deposit) => sum + deposit.amountMinor, 0n);
}

/** The scored sells and remaining book of the agent's own decisions (D39, D40). */
interface ScoredSell {
  at: Date;
  realisedMinor: bigint;
}

interface Book {
  quantity: bigint;
  /** What the shares still in the book cost, buy fees included. */
  costMinor: bigint;
}

export function replayAgentBook(fills: FillRow[]): { sells: ScoredSell[]; books: Map<string, Book> } {
  const books = new Map<string, Book>();
  const sells: ScoredSell[] = [];
  for (const fill of fills) {
    if (fill.source !== 'agent') continue;
    const quantity = wholeShares(fill.quantity);
    const notional = BigInt(fill.notional_minor);
    const fee = BigInt(fill.fee_minor);
    const book = books.get(fill.instrument_id) ?? { quantity: 0n, costMinor: 0n };
    if (fill.side === 'buy') {
      book.quantity += quantity;
      book.costMinor += notional + fee;
      books.set(fill.instrument_id, book);
      continue;
    }
    // Only shares the agent itself bought are scored; a sell of shares the
    // user bought by hand is the user's, and is left out (D39).
    const scored = quantity < book.quantity ? quantity : book.quantity;
    if (scored === 0n) continue;
    const cost = divideRounded(book.costMinor * scored, book.quantity);
    const proceeds = divideRounded((notional - fee) * scored, quantity);
    sells.push({ at: new Date(fill.created_at), realisedMinor: proceeds - cost });
    book.quantity -= scored;
    book.costMinor -= cost;
    books.set(fill.instrument_id, book);
  }
  return { sells, books };
}

/** The latest stored close of an instrument, by day. */
function latestClose(closes: Map<string, bigint> | undefined): bigint | null {
  if (!closes || closes.size === 0) return null;
  const latest = [...closes.keys()].sort().at(-1)!;
  return closes.get(latest)!;
}

export function scoreAgent(fills: FillRow[], closes: ClosesByInstrument, now: Date): AgentScore {
  const agentFills = fills.filter((fill) => fill.source === 'agent');
  const { sells, books } = replayAgentBook(fills);
  const windows: ScoreWindow[] = SCORE_WINDOWS_DAYS.map((days) => {
    const since = now.getTime() - days * DAY_MS;
    const inWindow = sells.filter((sell) => sell.at.getTime() >= since);
    const wins = inWindow.filter((sell) => sell.realisedMinor > 0n).length;
    return {
      days,
      decisions: agentFills.filter((fill) => new Date(fill.created_at).getTime() >= since).length,
      sells: inWindow.length,
      wins,
      winRatePct: inWindow.length > 0 ? (wins / inWindow.length) * 100 : null,
      realisedPnlMinor: Number(inWindow.reduce((sum, sell) => sum + sell.realisedMinor, 0n)),
    };
  });

  // The book may claim shares the user has since sold by hand; only what is
  // still held is valued, at its share of the book's cost.
  const held = holdingsAt(fills, now);
  let unrealised: bigint | null = 0n;
  for (const [instrumentId, book] of books) {
    if (book.quantity === 0n) continue;
    const actual = held.get(instrumentId) ?? 0n;
    const quantity = actual < book.quantity ? actual : book.quantity;
    if (quantity <= 0n) continue;
    const price = latestClose(closes.get(instrumentId));
    if (price === null) {
      unrealised = null;
      break;
    }
    unrealised += quantity * price - divideRounded(book.costMinor * quantity, book.quantity);
  }
  return { agentDecisions: agentFills.length, windows, unrealisedPnlMinor: toNumber(unrealised) };
}

export interface PerformanceInput {
  currency: string;
  /** The agent's cash timeline, oldest first (`listCashTimeline`). */
  movements: CashActivityRow[];
  /** The agent's fills, oldest first (`listFillsOldestFirst`). */
  fills: FillRow[];
  /** Every session from the first deposit's New York date to today, oldest first. */
  sessions: SessionClose[];
  closes: ClosesByInstrument;
  /** The benchmark's instrument id; null when it is not known on this installation. */
  benchmarkId: string | null;
  now: Date;
}

export function agentPerformance(input: PerformanceInput): AgentPerformanceResponse {
  const deposits = depositsOf(input.movements);
  const first = deposits[0];
  const closed = input.sessions.filter(
    (session) =>
      session.closesAt.getTime() <= input.now.getTime() &&
      first !== undefined &&
      session.closesAt.getTime() >= first.at.getTime(),
  );
  const benchmarkCloses = input.benchmarkId ? input.closes.get(input.benchmarkId) : undefined;
  // A session's close is stored by the next backfill, an hour or so after it.
  // Until then that session is not recorded yet - not unpriced - so the series
  // ends at the last one SPY has a close for, and later deposits are pending.
  const lastRecorded = closed.findLastIndex((session) => benchmarkCloses?.has(session.day));
  const recorded = closed.slice(0, lastRecorded + 1);

  const points = recorded.map((session) => ({
    session,
    deposits: depositedBy(deposits, session.closesAt),
    netWorth: netWorthOn(session, input.movements, input.fills, input.closes),
    benchmark: benchmarkOn(session, deposits, input.sessions, benchmarkCloses),
  }));
  const series: PerformancePoint[] = points.map((point) => ({
    day: point.session.day,
    netWorthMinor: toNumber(point.netWorth),
    benchmarkMinor: toNumber(point.benchmark),
    depositsMinor: Number(point.deposits),
  }));

  const last = points.at(-1);
  let comparison: PerformanceComparison | null = null;
  if (last) {
    const pnl = last.netWorth === null ? null : last.netWorth - last.deposits;
    const benchmarkPnl = last.benchmark === null ? null : last.benchmark - last.deposits;
    const returnPct = pnl === null ? null : pct(pnl, last.deposits);
    const benchmarkReturnPct = benchmarkPnl === null ? null : pct(benchmarkPnl, last.deposits);
    comparison = {
      day: last.session.day,
      depositsMinor: Number(last.deposits),
      netWorthMinor: toNumber(last.netWorth),
      pnlMinor: toNumber(pnl),
      returnPct,
      benchmarkMinor: toNumber(last.benchmark),
      benchmarkPnlMinor: toNumber(benchmarkPnl),
      benchmarkReturnPct,
      differencePts: returnPct === null || benchmarkReturnPct === null ? null : returnPct - benchmarkReturnPct,
    };
  }

  const cutoff = last ? last.session.closesAt.getTime() : -Infinity;
  const pending = deposits
    .filter((deposit) => deposit.at.getTime() > cutoff)
    .reduce((sum, deposit) => sum + deposit.amountMinor, 0n);

  return {
    currency: input.currency,
    benchmarkSymbol: BENCHMARK_SYMBOL,
    series,
    comparison,
    pendingDepositsMinor: Number(pending),
    score: scoreAgent(input.fills, input.closes, input.now),
  };
}
