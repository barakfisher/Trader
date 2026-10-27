/**
 * Symbol lookup for the add-holding form (D324, D325).
 *
 * Three reads, cheapest first:
 * - `GET /instruments`: every instrument the installation knows, sent whole
 *   once and filtered in the browser. Gzipped and stamped with an ETag, so a
 *   later visit costs an empty 304 until the list itself changes.
 * - `GET /instruments/search`: the market-data provider's search, asked only
 *   when the local list has no match. The AI service caches each query.
 * - `GET /instruments/:symbol/quote`: the latest price, to prefill the cost.
 */

import type { Hono } from 'hono';
import { compress } from 'hono/compress';
import { etag } from 'hono/etag';
import { z } from 'zod';

import type {
  InstrumentDirectoryResponse,
  InstrumentQuoteResponse,
  InstrumentSearchResponse,
} from '@traders/shared';
import { AiServiceError } from '@traders/shared/ai';

import { listInstrumentDirectory } from '../../db/queries.js';
import { currentUserId, type AppEnv } from '../app.js';
import { badRequest, upstreamFailure } from '../errors.js';
import { limitPerUser } from '../rateLimits.js';

/** The longest query or symbol the lookup accepts, as the AI service does. */
export const LOOKUP_MAX_LENGTH = 64;

const searchQuery = z.string().trim().min(1).max(LOOKUP_MAX_LENGTH);
const symbolParam = z
  .string()
  .trim()
  .min(1)
  .max(LOOKUP_MAX_LENGTH)
  .regex(/^[A-Za-z0-9.\-^=]+$/);

export function registerInstrumentsRoutes(app: Hono<AppEnv>): void {
  app.get('/instruments', compress(), etag(), async (context) => {
    currentUserId(context);
    const rows = await listInstrumentDirectory();
    const body: InstrumentDirectoryResponse = {
      instruments: rows.map((row) => ({
        symbol: row.symbol,
        name: row.name,
        assetClass: row.asset_class,
        exchange: row.exchange,
      })),
    };
    // Always revalidate: the ETag makes that an empty 304 while nothing changed.
    context.header('Cache-Control', 'private, no-cache');
    return context.json(body);
  });

  app.get('/instruments/search', limitPerUser('symbolLookup'), async (context) => {
    currentUserId(context);
    const parsed = searchQuery.safeParse(context.req.query('q') ?? '');
    if (!parsed.success) throw badRequest('invalid_query', 'q must be 1 to 64 characters');
    try {
      const response = await context.get('ai').searchInstruments(parsed.data, context.get('requestId'));
      const body: InstrumentSearchResponse = {
        query: parsed.data,
        matches: (response.matches ?? []).map((match) => ({
          symbol: match.symbol,
          name: match.name ?? null,
          assetClass: match.asset_class,
          exchange: match.exchange ?? null,
        })),
      };
      return context.json(body);
    } catch (error) {
      if (error instanceof AiServiceError) throw upstreamFailure(error.status, 'The symbol search failed.');
      throw error;
    }
  });

  app.get('/instruments/:symbol/quote', limitPerUser('symbolLookup'), async (context) => {
    currentUserId(context);
    const parsed = symbolParam.safeParse(context.req.param('symbol'));
    if (!parsed.success) throw badRequest('invalid_symbol', 'not a symbol');
    const symbol = parsed.data.toUpperCase();
    try {
      const response = await context.get('ai').quotes([symbol], context.get('requestId'));
      const quote = response.quotes.find((q) => q.symbol.toUpperCase() === symbol);
      // No price is null, never zero (guideline 7): the form leaves the cost empty.
      const body: InstrumentQuoteResponse = quote
        ? { symbol, priceMinor: quote.price_minor, currency: quote.currency, asOf: quote.as_of }
        : { symbol, priceMinor: null, currency: null, asOf: null };
      return context.json(body);
    } catch (error) {
      if (error instanceof AiServiceError) throw upstreamFailure(error.status, 'The price could not be read.');
      throw error;
    }
  });
}
