/**
 * The real portfolio's cash at the broker (D328-D330).
 *
 * The main portfolio keeps the agents' ledger once the user enters the cash
 * they have: `POST /portfolio/cash` opens it with that amount and records what
 * the holdings already held had cost (D329); `POST /portfolio/cash/movements`
 * records a deposit, a withdrawal, income or a charge, each for what it is
 * (D340); `PUT` sets it to what the broker shows, to put a typo right (D342).
 * Trades move it through the same fills as an agent's. Nothing here reaches a
 * broker.
 */

import type { Hono } from 'hono';
import { z } from 'zod';

import {
  PRIMARY_MOVEMENT_TYPES,
  type PrimaryCashInput,
  type PrimaryCashMovementInput,
  type PrimaryCashResponse,
} from '@traders/shared';

import {
  getPrimaryCash,
  getUser,
  listHoldings,
  openPrimaryCash,
  primaryAgentId,
  recordPrimaryMovement,
  setPrimaryCash,
  sumFeesPaid,
  transaction,
} from '../../db/queries.js';
import { valuePortfolio } from '../../services/valuation.js';
import { currentUserId, type AppEnv } from '../app.js';
import { limitPerUser } from '../rateLimits.js';
import { badRequest, conflict, notFound, unprocessable } from '../errors.js';
import { BUDGET_PATTERN, MAX_BUDGET_MINOR } from './agents.js';

const amountField = z.string().trim().max(20).regex(BUDGET_PATTERN, 'an amount in dollars, at most two decimal places');

const amountSchema = z.object({ amount: amountField }).strict() satisfies z.ZodType<PrimaryCashInput>;

const movementSchema = z
  .object({ type: z.enum(PRIMARY_MOVEMENT_TYPES), amount: amountField })
  .strict() satisfies z.ZodType<PrimaryCashMovementInput>;

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
    incomeMinor: Number(row.income_minor),
    chargesMinor: Number(row.charges_minor),
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

  /** One movement, for what it is (D340): money in or out moves the deposits; income and charges do not. */
  app.post('/portfolio/cash/movements', limitPerUser('cashMovement'), async (context) => {
    const userId = currentUserId(context);
    const parsed = movementSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) throw badRequest('invalid_body', 'cash movement payload failed validation', parsed.error.issues);
    const amount = toMinor(parsed.data.amount, false);
    const agentId = await primaryAgentId(userId);
    const outcome = await transaction((client) =>
      recordPrimaryMovement(client, userId, agentId, parsed.data.type, amount, MAX_BUDGET_MINOR),
    );
    if (outcome === 'unopened') throw conflict('cash_not_set', 'set the cash first');
    if (outcome === 'insufficient_cash') {
      throw unprocessable('insufficient_cash', 'that would take the cash below $0');
    }
    if (outcome === 'over_ceiling') {
      throw unprocessable('amount_out_of_range', `deposits may total at most $${MAX_BUDGET_MINOR / 100}`);
    }
    return context.json(await primaryCashView(userId, agentId), 201);
  });

  /** A correction: the balance set to what the broker shows, to put a typo right (D330, D342). */
  app.put('/portfolio/cash', async (context) => {
    const userId = currentUserId(context);
    const balance = await parseAmount(context, true);
    const agentId = await primaryAgentId(userId);
    const outcome = await transaction((client) => setPrimaryCash(client, userId, agentId, balance));
    if (outcome === 'unopened') throw conflict('cash_not_set', 'set the cash first');
    return context.json(await primaryCashView(userId, agentId));
  });
}
