/**
 * Manual holdings CRUD. Every write resolves the symbol through the provider
 * chain first: an instrument that cannot be priced is rejected at the door
 * rather than silently sitting in the portfolio as a blank row.
 */

import type { Hono } from 'hono';
import { z } from 'zod';

import {
  parseToMinor,
  type HoldingHistoryResponse,
  type HoldingNewsResponse,
} from '@traders/shared';
import { AiServiceError } from '@traders/shared/ai';

import {
  deleteHolding,
  getHolding,
  getLatestFinishedRun,
  getUser,
  listHoldingArticles,
  listHoldings,
  primaryAgentId,
  updateHolding,
  upsertHolding,
  upsertInstrument,
} from '../../db/queries.js';
import { currentUserId, type AppEnv } from '../app.js';
import { badRequest, notFound, unprocessable, upstreamFailure } from '../errors.js';
import { articleOut, collectionState } from '../newsArticles.js';
import { recordMissingTicker } from '../../services/universeGaps.js';

const DECIMAL = /^\d+(\.\d+)?$/;

/**
 * How far back a holding's chart reaches: a year. More than the daily backfill
 * fetches (180 days), because older stored closes are still real prices and the
 * chart shows what is stored - it never asks a provider for more.
 */
export const HOLDING_HISTORY_DAYS = 365;

/** A holding's news window: a week, as on a topic card. */
export const HOLDING_NEWS_DAYS = 7;

/** One page of a holding's news. AAPL links ~440 articles a week; the page says how many. */
export const HOLDING_NEWS_PAGE = 20;

const holdingId = z.string().uuid();

/** A holding id from the path. Not a UUID is "no such holding", not a 400 about UUIDs. */
function parseHoldingId(raw: string): string {
  const parsed = holdingId.safeParse(raw);
  if (!parsed.success) throw notFound('holding not found');
  return parsed.data;
}

const createSchema = z.object({
  symbol: z.string().min(1).max(32),
  quantity: z.string().regex(DECIMAL, 'quantity must be a positive decimal string'),
  costBasis: z.string().regex(DECIMAL).nullish(),
  currency: z.string().length(3).optional(),
  openedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  notes: z.string().max(500).nullish(),
});

const patchSchema = z.object({
  quantity: z.string().regex(DECIMAL).optional(),
  costBasis: z.string().regex(DECIMAL).nullish(),
  currency: z.string().length(3).optional(),
  openedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  notes: z.string().max(500).nullish(),
});

export function registerHoldingsRoutes(app: Hono<AppEnv>): void {
  app.get('/holdings', async (context) => {
    const userId = currentUserId(context);
    const rows = await listHoldings(userId, await primaryAgentId(userId));
    return context.json({
      holdings: rows.map((row) => ({
        id: row.id,
        symbol: row.symbol,
        name: row.name,
        assetClass: row.asset_class,
        quantity: row.quantity,
        costBasisMinor: row.cost_basis_minor === null ? null : Number(row.cost_basis_minor),
        currency: row.currency,
        openedAt: row.opened_at ? String(row.opened_at).slice(0, 10) : null,
        notes: row.notes,
      })),
    });
  });

  /**
   * The holding's daily closes, for its chart: the series the analysis rules
   * read, from the AI service, which owns "what is a day's close" and "which
   * stored prices are real". The holding is looked up first, so another user's
   * holding - or an instrument id guessed into the path - is a 404.
   */
  app.get('/holdings/:id/history', async (context) => {
    const userId = currentUserId(context);
    const holding = await getHolding(
      userId,
      await primaryAgentId(userId),
      parseHoldingId(context.req.param('id')),
    );
    if (!holding) throw notFound('holding not found');
    try {
      const history = await context
        .get('ai')
        .priceHistory(holding.instrument_id, HOLDING_HISTORY_DAYS, context.get('requestId'));
      const body: HoldingHistoryResponse = {
        holdingId: holding.id,
        symbol: holding.symbol,
        days: history.days,
        closes: history.closes.map((close) => ({
          day: close.day,
          priceMinor: close.price_minor,
          currency: close.currency,
          asOf: new Date(close.as_of).toISOString(),
        })),
      };
      return context.json(body);
    } catch (error) {
      if (error instanceof AiServiceError) {
        throw upstreamFailure(error.status, 'The price history could not be read.');
      }
      throw error;
    }
  });

  /**
   * The holding's week of news, newest first, one page of it with the total.
   * As on a topic card, the latest collection travels with it, so an empty list
   * can tell a quiet week from news that could not be collected.
   */
  app.get('/holdings/:id/news', async (context) => {
    const userId = currentUserId(context);
    const agentId = await primaryAgentId(userId);
    const holding = await getHolding(userId, agentId, parseHoldingId(context.req.param('id')));
    if (!holding) throw notFound('holding not found');
    const [rows, lastRun] = await Promise.all([
      listHoldingArticles(userId, agentId, holding.id, HOLDING_NEWS_DAYS, HOLDING_NEWS_PAGE),
      getLatestFinishedRun(userId, 'news_collect'),
    ]);
    const body: HoldingNewsResponse = {
      holdingId: holding.id,
      symbol: holding.symbol,
      days: HOLDING_NEWS_DAYS,
      articles: rows.map(articleOut),
      total: rows.length === 0 ? 0 : Number(rows[0]!.total),
      collection: lastRun ? collectionState(lastRun) : null,
    };
    return context.json(body);
  });

  app.post('/holdings', async (context) => {
    const userId = currentUserId(context);
    const user = await getUser(userId);
    if (!user) throw notFound('user not found');

    const parsed = createSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      throw badRequest('invalid_body', 'holding payload failed validation', parsed.error.issues);
    }
    const input = parsed.data;
    if (Number(input.quantity) <= 0) {
      throw unprocessable('invalid_quantity', 'quantity must be greater than zero');
    }

    const resolution = await context
      .get('ai')
      .resolveInstrument(input.symbol, context.get('requestId'));
    await recordMissingTicker(
      { userId, timezone: user.timezone, ai: context.get('ai'), requestId: context.get('requestId') },
      input.symbol,
      resolution,
      'holding',
    );
    if (!resolution.resolved) {
      throw unprocessable(
        'unresolved_symbol',
        `no market data provider could price "${input.symbol}"`,
        { candidates: resolution.candidates },
      );
    }

    const currency = (input.currency ?? resolution.resolved.currency ?? user.base_currency).toUpperCase();
    const instrument = await upsertInstrument({
      symbol: resolution.resolved.symbol,
      name: resolution.resolved.name,
      assetClass: resolution.resolved.asset_class,
      exchange: resolution.resolved.exchange,
      currency: resolution.resolved.currency,
    });

    const result = await upsertHolding({
      userId,
      // A holding entered by hand is the real portfolio's (Stage 1: the only one).
      agentId: await primaryAgentId(userId),
      instrumentId: instrument.id,
      quantity: input.quantity,
      costBasisMinor: input.costBasis ? parseToMinor(input.costBasis, currency) : null,
      currency,
      openedAt: input.openedAt ?? null,
      notes: input.notes ?? null,
    });

    return context.json({ id: result.id, created: result.inserted, symbol: instrument.symbol }, result.inserted ? 201 : 200);
  });

  app.patch('/holdings/:id', async (context) => {
    const userId = currentUserId(context);
    const agentId = await primaryAgentId(userId);
    const parsed = patchSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      throw badRequest('invalid_body', 'patch failed validation', parsed.error.issues);
    }
    const { costBasis, ...rest } = parsed.data;
    const currency = rest.currency?.toUpperCase();
    // A cost with no currency is in the holding's own currency. This used to
    // read it at USD's exponent, so 1500 JPY was stored as 150000 - a hundred
    // times the cost - whenever a client sent the amount alone.
    let costCurrency = currency;
    if (costBasis != null && costCurrency === undefined) {
      const holding = await getHolding(userId, agentId, context.req.param('id'));
      if (!holding) throw notFound('holding not found');
      costCurrency = holding.currency;
    }
    const updated = await updateHolding(userId, agentId, context.req.param('id'), {
      ...rest,
      ...(currency ? { currency } : {}),
      ...(costBasis === undefined
        ? {}
        : {
            costBasisMinor: costBasis === null ? null : parseToMinor(costBasis, costCurrency!),
          }),
    });
    if (!updated) throw notFound('holding not found');
    return context.json({ id: updated.id, symbol: updated.symbol });
  });

  app.delete('/holdings/:id', async (context) => {
    const userId = currentUserId(context);
    const removed = await deleteHolding(userId, await primaryAgentId(userId), context.req.param('id'));
    if (!removed) throw notFound('holding not found');
    return context.json({ ok: true });
  });
}
