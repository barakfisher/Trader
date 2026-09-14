/**
 * Manual holdings CRUD. Every write resolves the symbol through the provider
 * chain first: an instrument that cannot be priced is rejected at the door
 * rather than silently sitting in the portfolio as a blank row.
 */

import type { Hono } from 'hono';
import { z } from 'zod';

import { parseToMinor } from '@traders/shared';

import {
  deleteHolding,
  getUser,
  listHoldings,
  updateHolding,
  upsertHolding,
  upsertInstrument,
} from '../../db/queries.js';
import { currentUserId, type AppEnv } from '../app.js';
import { badRequest, notFound, unprocessable } from '../errors.js';

const DECIMAL = /^\d+(\.\d+)?$/;

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
    const rows = await listHoldings(currentUserId(context));
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
    const parsed = patchSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      throw badRequest('invalid_body', 'patch failed validation', parsed.error.issues);
    }
    const { costBasis, ...rest } = parsed.data;
    const currency = rest.currency?.toUpperCase();
    const updated = await updateHolding(userId, context.req.param('id'), {
      ...rest,
      ...(currency ? { currency } : {}),
      ...(costBasis === undefined
        ? {}
        : { costBasisMinor: costBasis === null ? null : parseToMinor(costBasis, currency ?? 'USD') }),
    });
    if (!updated) throw notFound('holding not found');
    return context.json({ id: updated.id, symbol: updated.symbol });
  });

  app.delete('/holdings/:id', async (context) => {
    const removed = await deleteHolding(currentUserId(context), context.req.param('id'));
    if (!removed) throw notFound('holding not found');
    return context.json({ ok: true });
  });
}
