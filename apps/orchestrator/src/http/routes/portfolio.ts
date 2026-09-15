/**
 * Portfolio read endpoints. Valuation is computed on demand: quotes are cached
 * in the AI service, so a refresh is cheap and always reflects the current
 * holdings rather than a stale materialised view.
 */

import type { Hono } from 'hono';
import type { SnapshotsResponse } from '@traders/shared';

import { getUser, listHoldings, listSnapshots, recordQuotes } from '../../db/queries.js';
import { logger } from '../../logger.js';
import { valuePortfolio } from '../../services/valuation.js';
import { currentUserId, type AppEnv } from '../app.js';
import { notFound } from '../errors.js';

export function registerPortfolioRoutes(app: Hono<AppEnv>): void {
  app.get('/portfolio', async (context) => {
    const userId = currentUserId(context);
    const user = await getUser(userId);
    if (!user) throw notFound('user not found');

    const rows = await listHoldings(userId);
    const portfolio = await valuePortfolio(rows, {
      baseCurrency: user.base_currency,
      ai: context.get('ai'),
      requestId: context.get('requestId'),
    });

    // Persist the quotes we just used, so M2's analysis has a price history to
    // work from without a separate backfill. Failure here must not fail the read.
    const quotesToStore = portfolio.holdings
      .filter((holding) => holding.quote && !holding.quote.stale)
      .map((holding) => ({
        instrumentId: holding.instrument.id,
        asOf: holding.quote!.asOf,
        priceMinor: holding.quote!.priceMinor,
        currency: holding.quote!.currency,
        source: holding.quote!.source,
        delaySeconds: holding.quote!.delaySeconds,
      }));
    recordQuotes(quotesToStore).catch((error) =>
      logger().warn({ err: error }, 'failed to record quote history'),
    );

    return context.json(portfolio);
  });

  app.get('/portfolio/snapshots', async (context) => {
    const userId = currentUserId(context);
    const limit = Number(context.req.query('limit') ?? 365);
    const rows = await listSnapshots(userId, Number.isFinite(limit) ? Math.min(limit, 3650) : 365);
    const response: SnapshotsResponse = {
      snapshots: rows
        .map((row) => ({
          asOf: row.as_of instanceof Date ? row.as_of.toISOString().slice(0, 10) : String(row.as_of),
          totalMinor: Number(row.total_minor),
          costMinor: Number(row.cost_minor),
          currency: row.currency,
          // Provenance travels with every point: a client charting the series
          // has to be able to mark an approximate total as approximate.
          holdingsCount: Number(row.holdings_count),
          pricedCount: Number(row.priced_count),
          degraded: row.degraded,
        }))
        .reverse(),
    };
    return context.json(response);
  });
}
