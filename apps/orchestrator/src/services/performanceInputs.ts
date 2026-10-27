/**
 * Everything `agentPerformance` needs, read for one agent: its cash timeline
 * and fills from the ledger, the benchmark's instrument, and the calendar and
 * stored closes from the AI service (D24, D36-D42). The performance route and
 * the agent review (D343) both compute from this, so the figure a review
 * quotes is the one the Performance tab shows.
 */

import type { AgentPerformanceResponse } from '@traders/shared';
import type { AiClient } from '@traders/shared/ai';

import { findInstrumentsBySymbols, listCashTimeline, listFillsOldestFirst, type AgentRow } from '../db/queries.js';
import { BENCHMARK_SYMBOL, agentPerformance, type ClosesByInstrument } from './performance.js';

/** The exchange whose calendar an agent's days are counted on: the benchmark's (D25, D37). */
const BENCHMARK_EXCHANGE = 'PCX';

/** A day as New York names it - the calendar's and the closes' dates. */
function newYorkDay(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/**
 * The agent against the same deposits held in SPY. Throws the AI client's
 * error when the calendar or a price history cannot be read; the caller
 * decides what that means.
 */
export async function readAgentPerformance(
  userId: string,
  agent: Pick<AgentRow, 'id' | 'currency'>,
  ai: AiClient,
  now: Date,
  requestId?: string,
): Promise<AgentPerformanceResponse> {
  const [movements, fills, [benchmark]] = await Promise.all([
    listCashTimeline(userId, agent.id),
    listFillsOldestFirst(userId, agent.id),
    findInstrumentsBySymbols([BENCHMARK_SYMBOL]),
  ]);
  const closes: ClosesByInstrument = new Map();
  let sessions: { day: string; closesAt: Date }[] = [];
  const first = movements[0];
  if (first) {
    const start = newYorkDay(new Date(first.created_at));
    // A week of slack, so the first session's close is inside what is asked for.
    const days = Math.ceil((now.getTime() - new Date(first.created_at).getTime()) / 86_400_000) + 7;
    const instrumentIds = [...new Set([...fills.map((fill) => fill.instrument_id), ...(benchmark ? [benchmark.id] : [])])];
    const [calendar, histories] = await Promise.all([
      ai.marketSessions(BENCHMARK_EXCHANGE, start, newYorkDay(now), requestId),
      Promise.all(instrumentIds.map((id) => ai.priceHistory(id, Math.min(days, 3650), requestId))),
    ]);
    sessions = calendar.sessions.map((session) => ({ day: session.day, closesAt: new Date(session.closes_at) }));
    histories.forEach((history) =>
      closes.set(history.instrument_id, new Map(history.closes.map((close) => [close.day, BigInt(close.price_minor)]))),
    );
  }
  return agentPerformance({
    currency: agent.currency,
    movements,
    fills,
    sessions,
    closes,
    benchmarkId: benchmark?.id ?? null,
    now,
  });
}
