/**
 * Trades the user places by hand into a simulated agent's account (Stage 3,
 * decisions D21 and D27-D30 in `docs/PROPOSAL-MULTI-AGENT.md`).
 *
 * Two steps, as the form takes them: a **preview** computes what the trade
 * would do - price, fee, cash and holding after - and writes nothing; the
 * **trade** re-checks everything and records the fill, filling at the live
 * price only if it is within 0.5% of the price the preview showed (D27). Both
 * run through `services/fills.ts`, the path Stage 4's approvals will share.
 */

import { randomUUID } from 'node:crypto';

import type { Context, Hono } from 'hono';
import { z } from 'zod';

import type { FillsResponse, TradeInput } from '@traders/shared';

import { getAgent, getUser, listFills } from '../../db/queries.js';
import {
  executeFill,
  parseTypedPrice,
  previewTrade,
  toFillView,
  type TradeContext,
  type TradeRequest,
} from '../../services/fills.js';
import { currentUserId, type AppEnv } from '../app.js';
import { badRequest, notFound } from '../errors.js';
import { agentIdFrom } from './agents.js';

/** How many fills the activity list returns: an agent's history for a while. */
export const FILLS_PAGE = 200;

const tradeSchema = z
  .object({
    symbol: z.string().trim().min(1).max(32),
    side: z.enum(['buy', 'sell']),
    quantity: z.string().trim().min(1).max(16),
    price: z.string().trim().min(1).max(20).optional(),
    shownPriceMinor: z.number().int().positive().safe().optional(),
    idempotencyKey: z.string().trim().min(1).max(128).optional(),
  })
  .strict() satisfies z.ZodType<TradeInput>;

async function requestFrom(
  context: Context<AppEnv>,
  preview: boolean,
): Promise<{ request: TradeRequest; tradeContext: TradeContext }> {
  const userId = currentUserId(context);
  const parsed = tradeSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) {
    throw badRequest(
      'invalid_body',
      'expected { symbol, side, quantity, price?, shownPriceMinor?, idempotencyKey? }',
      parsed.error.issues,
    );
  }
  const user = await getUser(userId);
  if (!user) throw notFound('user not found');
  const agent = await getAgent(userId, agentIdFrom(context.req.param('id') ?? ''));
  if (!agent) throw notFound('agent not found');
  const input = parsed.data;
  const request: TradeRequest = {
    userId,
    agent,
    symbol: input.symbol,
    side: input.side,
    quantity: input.quantity,
    price:
      input.price !== undefined
        ? { source: 'user', priceMinor: parseTypedPrice(input.price) }
        : {
            source: 'quote',
            shownPriceMinor:
              preview || input.shownPriceMinor === undefined ? null : BigInt(input.shownPriceMinor),
          },
    source: 'manual_user_override',
    // Without a key a submit is its own trade: the form always sends one.
    idempotencyKey: input.idempotencyKey ?? randomUUID(),
  };
  return {
    request,
    tradeContext: {
      ai: context.get('ai'),
      requestId: context.get('requestId'),
      timezone: user.timezone,
    },
  };
}

export function registerTradesRoutes(app: Hono<AppEnv>): void {
  app.post('/agents/:id/trades/preview', async (context) => {
    const { request, tradeContext } = await requestFrom(context, true);
    return context.json(await previewTrade(request, tradeContext));
  });

  app.post('/agents/:id/trades', async (context) => {
    const { request, tradeContext } = await requestFrom(context, false);
    const result = await executeFill(request, tradeContext);
    return context.json(result, result.created ? 201 : 200);
  });

  app.get('/agents/:id/fills', async (context) => {
    const userId = currentUserId(context);
    const agent = await getAgent(userId, agentIdFrom(context.req.param('id')));
    if (!agent) throw notFound('agent not found');
    const body: FillsResponse = {
      fills: (await listFills(userId, agent.id, FILLS_PAGE)).map(toFillView),
    };
    return context.json(body);
  });
}
