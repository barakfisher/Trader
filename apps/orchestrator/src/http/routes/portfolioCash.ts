/**
 * The real portfolio's cash at the broker (D328-D330).
 *
 * The main portfolio keeps the agents' ledger once the user enters the cash
 * they have: `POST /portfolio/cash` opens it with that amount and records what
 * the holdings already held had cost (D329); a deposit raises it; `PUT` sets it
 * to what the broker shows, as a correction. Trades move it in PR 3 of the
 * plan, through the same fills as an agent's. Nothing here reaches a broker.
 */

import type { Hono } from 'hono';
import { z } from 'zod';

import type { PrimaryCashInput, PrimaryCashResponse } from '@traders/shared';

import {
  depositPrimaryCash,
  getPrimaryCash,
  getUser,
  listHoldings,
  openPrimaryCash,
  primaryAgentId,
  setPrimaryCash,
  sumFeesPaid,
  transaction,
} from '../../db/queries.js';
import { valuePortfolio } from '../../services/valuation.js';
import { currentUserId, type AppEnv } from '../app.js';
import { badRequest, conflict, notFound, unprocessable } from '../errors.js';
import { BUDGET_PATTERN, MAX_BUDGET_MINOR } from './agents.js';

const amountSchema = z
  .object({
    amount: z.string().trim().max(20).regex(BUDGET_PATTERN, 'an amount in dollars, at most two decimal places'),
  })
  .strict() satisfies z.ZodType<PrimaryCashInput>;

/** Whole cents from a validated amount; zero is a real balance, a deposit must be more. */
function toMinor(text: string, allowZero: boolean): number {
  const [whole, fraction = ''] = text.split('.');
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(minor) || minor > MAX_BUDGET_MINOR || (!allowZero && minor === 0)) {
    throw unprocessable(
      'amount_out_of_range',
      `an amount must be ${allowZero ? 'at least' : 'more than'} $0 and at most $${MAX_BUDGET_MINOR / 100}`,
    );
  }
  return minor;
}

async function parseAmount(context: { req: { json: () => Promise<unknown> } }, allowZero: boolean): Promise<number> {
  const parsed = amountSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) throw badRequest('invalid_body', 'cash payload failed validation', parsed.error.issues);
  return toMinor(parsed.data.amount, allowZero);
}

export async function primaryCashView(userId: string, agentId: string): Promise<PrimaryCashResponse> {
  const row = await getPrimaryCash(userId, agentId);
  if (!row || row.budget_minor === null || row.balance_minor === null) return { state: 'unset' };
  const deposits = Number(row.budget_minor);
  const openingHoldings = Number(row.opening_holdings_cost_minor ?? 0);
  return {
    state: 'open',
    currency: row.currency,
    cashMinor: Number(row.balance_minor),
    depositsMinor: deposits,
    openingHoldingsCostMinor: openingHoldings,
    investedMinor: deposits + openingHoldings,
    feesPaidMinor: await sumFeesPaid(userId, agentId),
  };
}

export function registerPortfolioCashRoutes(app: Hono<AppEnv>): void {
  app.get('/portfolio/cash', async (context) => {
    const userId = currentUserId(context);
    return context.json(await primaryCashView(userId, await primaryAgentId(userId)));
  });

  /** Open: the cash at the broker, and the holdings' cost at this moment (D328, D329). */
  app.post('/portfolio/cash', async (context) => {
    const userId = currentUserId(context);
    const user = await getUser(userId);
    if (!user) throw notFound('user not found');
    const cash = await parseAmount(context, true);
    const agentId = await primaryAgentId(userId);
    // In the base currency, uncosted holdings left out: what was invested is
    // what a cost says, never a guess (guideline 7).
    const valued = await valuePortfolio(await listHoldings(userId, agentId), {
      baseCurrency: user.base_currency,
      ai: context.get('ai'),
      requestId: context.get('requestId'),
    });
    const opened = await openPrimaryCash(userId, agentId, cash, Math.max(0, valued.summary.totalCostMinor));
    if (!opened) throw conflict('cash_already_set', 'the cash is already set: deposit, or correct it');
    return context.json(await primaryCashView(userId, agentId), 201);
  });

  app.post('/portfolio/cash/deposits', async (context) => {
    const userId = currentUserId(context);
    const amount = await parseAmount(context, false);
    const agentId = await primaryAgentId(userId);
    if (!(await depositPrimaryCash(userId, agentId, amount, MAX_BUDGET_MINOR))) {
      const current = await primaryCashView(userId, agentId);
      if (current.state === 'unset') throw conflict('cash_not_set', 'set the cash first');
      throw unprocessable('amount_out_of_range', `deposits may total at most $${MAX_BUDGET_MINOR / 100}`);
    }
    return context.json(await primaryCashView(userId, agentId));
  });

  /** A correction: the balance set to what the broker shows (D330). */
  app.put('/portfolio/cash', async (context) => {
    const userId = currentUserId(context);
    const balance = await parseAmount(context, true);
    const agentId = await primaryAgentId(userId);
    const outcome = await transaction((client) => setPrimaryCash(client, userId, agentId, balance));
    if (outcome === 'unopened') throw conflict('cash_not_set', 'set the cash first');
    if (outcome === 'below_zero') {
      throw unprocessable('correction_too_large', 'that correction would take the deposits below $0');
    }
    return context.json(await primaryCashView(userId, agentId));
  });
}
