/**
 * A simulated agent's account: its value, its cash timeline, and adding cash
 * (Stage 3, PR 5; decisions D6, D22 and D31 in `docs/PROPOSAL-MULTI-AGENT.md`).
 *
 * The real portfolio has no account here - it has no cash and never trades
 * (D1) - so each route answers 409 for the primary, as the agents API does.
 */

import type { Hono } from 'hono';
import { z } from 'zod';

import type { ActivityEntry, ActivityResponse, AgentPerformanceResponse, TopUpInput } from '@traders/shared';
import { AiServiceError } from '@traders/shared/ai';

import {
  findInstrumentsBySymbols,
  getAgent,
  getUser,
  listCashActivity,
  listCashTimeline,
  listFillsByIds,
  listFillsOldestFirst,
  listHoldings,
  topUpAgent,
  type AgentRow,
} from '../../db/queries.js';
import { valueAgentAccount } from '../../services/agentAccount.js';
import { toFillView } from '../../services/fills.js';
import { BENCHMARK_SYMBOL, agentPerformance, type ClosesByInstrument } from '../../services/performance.js';
import { currentUserId, type AppEnv } from '../app.js';
import { badRequest, conflict, notFound, unprocessable, upstreamFailure } from '../errors.js';
import { BUDGET_PATTERN, MAX_BUDGET_MINOR, agentIdFrom, budgetToMinor, toAgentView } from './agents.js';

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

/** How many movements the activity timeline returns. */
export const ACTIVITY_PAGE = 200;

const topUpSchema = z
  .object({
    amount: z.string().trim().max(20).regex(BUDGET_PATTERN, 'an amount in dollars, at most two decimal places'),
  })
  .strict() satisfies z.ZodType<TopUpInput>;

function simulated(agent: AgentRow | null): AgentRow {
  if (!agent) throw notFound('agent not found');
  if (agent.is_primary) {
    throw conflict('primary_agent_is_passive', 'the real portfolio has no cash account: it never trades');
  }
  return agent;
}

export function registerAgentAccountRoutes(app: Hono<AppEnv>): void {
  app.get('/agents/:id/account', async (context) => {
    const userId = currentUserId(context);
    const user = await getUser(userId);
    if (!user) throw notFound('user not found');
    const agent = simulated(await getAgent(userId, agentIdFrom(context.req.param('id'))));
    const rows = await listHoldings(userId, agent.id);
    return context.json(
      await valueAgentAccount(agent, rows, {
        baseCurrency: agent.currency,
        ai: context.get('ai'),
        requestId: context.get('requestId'),
      }),
    );
  });

  app.get('/agents/:id/activity', async (context) => {
    const userId = currentUserId(context);
    const agent = simulated(await getAgent(userId, agentIdFrom(context.req.param('id'))));
    const movements = await listCashActivity(userId, agent.id, ACTIVITY_PAGE);
    const fillIds = movements.flatMap((row) => (row.fill_id ? [row.fill_id] : []));
    const fills = new Map(
      (await listFillsByIds(userId, agent.id, fillIds)).map((fill) => [fill.id, toFillView(fill)]),
    );
    const entries: ActivityEntry[] = movements.map((row) => ({
      id: row.id,
      kind: row.kind,
      amountMinor: Number(row.amount_minor),
      balanceAfterMinor: Number(row.balance_after_minor),
      createdAt: row.created_at.toISOString(),
      fill: row.fill_id ? (fills.get(row.fill_id) ?? null) : null,
    }));
    const body: ActivityResponse = { currency: agent.currency, entries };
    return context.json(body);
  });

  /**
   * The agent against the same deposits held in SPY, day by day, and the score
   * of its own decisions (D24, D36-D42). Computed from the ledger and stored
   * closes on each request; nothing is stored.
   */
  app.get('/agents/:id/performance', async (context) => {
    const userId = currentUserId(context);
    const agent = simulated(await getAgent(userId, agentIdFrom(context.req.param('id'))));
    const [movements, fills, [benchmark]] = await Promise.all([
      listCashTimeline(userId, agent.id),
      listFillsOldestFirst(userId, agent.id),
      findInstrumentsBySymbols([BENCHMARK_SYMBOL]),
    ]);
    const now = new Date();
    const closes: ClosesByInstrument = new Map();
    let sessions: { day: string; closesAt: Date }[] = [];
    const first = movements[0];
    if (first) {
      const ai = context.get('ai');
      const requestId = context.get('requestId');
      const start = newYorkDay(new Date(first.created_at));
      // A week of slack, so the first session's close is inside what is asked for.
      const days = Math.ceil((now.getTime() - new Date(first.created_at).getTime()) / 86_400_000) + 7;
      const instrumentIds = [...new Set([...fills.map((fill) => fill.instrument_id), ...(benchmark ? [benchmark.id] : [])])];
      try {
        const [calendar, histories] = await Promise.all([
          ai.marketSessions(BENCHMARK_EXCHANGE, start, newYorkDay(now), requestId),
          Promise.all(instrumentIds.map((id) => ai.priceHistory(id, Math.min(days, 3650), requestId))),
        ]);
        sessions = calendar.sessions.map((session) => ({ day: session.day, closesAt: new Date(session.closes_at) }));
        histories.forEach((history) =>
          closes.set(
            history.instrument_id,
            new Map(history.closes.map((close) => [close.day, BigInt(close.price_minor)])),
          ),
        );
      } catch (error) {
        if (error instanceof AiServiceError) {
          throw upstreamFailure(error.status, 'The calendar or the price history could not be read.');
        }
        throw error;
      }
    }
    const body: AgentPerformanceResponse = agentPerformance({
      currency: agent.currency,
      movements,
      fills,
      sessions,
      closes,
      benchmarkId: benchmark?.id ?? null,
      now,
    });
    return context.json(body);
  });

  app.post('/agents/:id/top-ups', async (context) => {
    const userId = currentUserId(context);
    const parsed = topUpSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) throw badRequest('invalid_body', 'expected { amount } in dollars, at most two decimals', parsed.error.issues);
    const agent = simulated(await getAgent(userId, agentIdFrom(context.req.param('id'))));
    if (agent.state === 'archived') {
      throw conflict('agent_archived', 'an archived agent is read-only history; restore it to add cash');
    }
    const amount = budgetToMinor(parsed.data.amount);
    const updated = await topUpAgent(userId, agent.id, amount, MAX_BUDGET_MINOR);
    if (!updated) {
      throw unprocessable(
        'budget_out_of_range',
        `a budget may be at most $${MAX_BUDGET_MINOR / 100}, deposits included`,
      );
    }
    const after = await getAgent(userId, agent.id);
    if (!after) throw notFound('agent not found');
    return context.json(toAgentView(after));
  });
}
