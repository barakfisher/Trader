/**
 * Agents: list, create, read and change the user's simulated portfolios
 * (multi-agent Stage 2, decisions D17-D20 in `docs/PROPOSAL-MULTI-AGENT.md`).
 *
 * Stage 2 is management only. An agent here has a name, a notional budget
 * (D2: typed by the user, taken from nothing), a persona that nothing reads
 * until Stage 4 (D20), and a state. It cannot trade until Stage 3's ledger, so
 * it holds nothing yet. The primary - the real portfolio - is listed, and is
 * never changed here (D1).
 */

import { randomUUID } from 'node:crypto';

import type { Hono } from 'hono';
import { z } from 'zod';

import type { AgentView, AgentsResponse } from '@traders/shared';

import {
  agentHasTraded,
  createAgent,
  getAgent,
  listAgents,
  updateAgent,
  type AgentRow,
} from '../../db/queries.js';
import { currentUserId, type AppEnv } from '../app.js';
import { badRequest, conflict, notFound, unprocessable } from '../errors.js';

/** Agents trade USD-listed instruments only in v1 (decision D7), so their budgets are USD. */
export const AGENT_CURRENCY = 'USD';

/**
 * A ceiling on a paper budget: $1,000,000,000. Far above any budget anyone
 * would simulate; it exists so the amount stays an exact integer in
 * JavaScript, where a minor-unit count past 2^53 would silently round.
 */
export const MAX_BUDGET_MINOR = 100_000_000_000;

/** Long enough for a real strategy brief, short enough to fit a prompt (Stage 4). */
export const MAX_PERSONA_LENGTH = 4000;

export const MAX_NAME_LENGTH = 60;

/** Dollars and cents, no more: a third decimal would round on the way in. */
const BUDGET_PATTERN = /^\d+(\.\d{1,2})?$/;

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

const name = z.string().trim().min(1).max(MAX_NAME_LENGTH);
const budget = z.string().trim().regex(BUDGET_PATTERN, 'budget must be an amount in dollars, at most two decimal places');
const persona = z.string().trim().max(MAX_PERSONA_LENGTH).nullable();

const createSchema = z.object({ name, budget, persona: persona.optional() });
const patchSchema = z
  .object({
    name: name.optional(),
    budget: budget.optional(),
    persona: persona.optional(),
    state: z.enum(['active', 'paused', 'archived']).optional(),
  })
  .strict();

/** Whole cents from a validated decimal string, refusing zero and the ceiling. */
export function budgetToMinor(text: string): number {
  const [whole, fraction = ''] = text.split('.');
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(minor) || minor <= 0 || minor > MAX_BUDGET_MINOR) {
    throw unprocessable(
      'budget_out_of_range',
      `a budget must be more than $0 and at most $${MAX_BUDGET_MINOR / 100}`,
    );
  }
  return minor;
}

export function toAgentView(row: AgentRow): AgentView {
  return {
    id: row.id,
    name: row.name,
    isPrimary: row.is_primary,
    persona: row.persona,
    budgetMinor: row.budget_minor === null ? null : Number(row.budget_minor),
    currency: row.currency,
    state: row.state,
    holdingsCount: row.holdings_count,
    createdAt: row.created_at.toISOString(),
  };
}

/** An empty persona is no persona: stored as null, never as ''. */
function personaOf(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return value === null || value === '' ? null : value;
}

/**
 * The database's own refusal of a lower budget after a trade (migration 0040),
 * met only when a fill lands between the check below and the update.
 */
function isBudgetCutAfterTrade(error: unknown): boolean {
  const pg = error as { code?: string; message?: string };
  return pg.code === CHECK_VIOLATION && (pg.message ?? '').includes('budget_decrease_after_trade');
}

function budgetCutAfterTrade() {
  return conflict(
    'budget_decrease_after_trade',
    'this agent has traded: its budget can be raised (a top-up), not lowered',
  );
}

function isNameTaken(error: unknown): boolean {
  const pg = error as { code?: string; constraint?: string };
  return pg.code === UNIQUE_VIOLATION && (pg.constraint ?? '').includes('name');
}

/** An id that is not a uuid names no agent; asked of Postgres it would be an error, not a 404. */
function agentIdFrom(raw: string): string {
  if (!z.string().uuid().safeParse(raw).success) throw notFound('agent not found');
  return raw;
}

const nameTaken = () => conflict('agent_name_taken', 'you already have an agent with that name');

export function registerAgentsRoutes(app: Hono<AppEnv>): void {
  app.get('/agents', async (context) => {
    const rows = await listAgents(currentUserId(context));
    const body: AgentsResponse = { agents: rows.map(toAgentView) };
    return context.json(body);
  });

  app.get('/agents/:id', async (context) => {
    const row = await getAgent(currentUserId(context), agentIdFrom(context.req.param('id')));
    if (!row) throw notFound('agent not found');
    return context.json(toAgentView(row));
  });

  app.post('/agents', async (context) => {
    const parsed = createSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      throw badRequest('invalid_body', 'expected { name, budget, persona? }', parsed.error.issues);
    }
    const input = parsed.data;
    try {
      const row = await createAgent({
        userId: currentUserId(context),
        // The slug is an identity, not a label: random, so a renamed agent keeps
        // it, and a name in any script makes one. `primary-portfolio` is the
        // primary's and cannot collide with this shape.
        slug: `agent-${randomUUID().slice(0, 8)}`,
        name: input.name,
        persona: personaOf(input.persona) ?? null,
        budgetMinor: budgetToMinor(input.budget),
        currency: AGENT_CURRENCY,
      });
      return context.json(toAgentView(row), 201);
    } catch (error) {
      if (isNameTaken(error)) throw nameTaken();
      throw error;
    }
  });

  app.patch('/agents/:id', async (context) => {
    const userId = currentUserId(context);
    const parsed = patchSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      throw badRequest('invalid_body', 'expected { name?, budget?, persona?, state? }', parsed.error.issues);
    }
    const agentId = agentIdFrom(context.req.param('id'));
    const existing = await getAgent(userId, agentId);
    if (!existing) throw notFound('agent not found');
    if (existing.is_primary) {
      throw conflict(
        'primary_agent_is_passive',
        'the real portfolio is not an agent you can change: it has no budget, persona or pause',
      );
    }
    const patch = parsed.data;
    const budgetMinor = patch.budget === undefined ? undefined : budgetToMinor(patch.budget);
    // D22: before the first fill a budget edit replaces the opening deposit; after
    // it, a raise is a top-up and a cut is refused. The database enforces the same.
    if (
      budgetMinor !== undefined &&
      budgetMinor < Number(existing.budget_minor) &&
      (await agentHasTraded(userId, agentId))
    ) {
      throw budgetCutAfterTrade();
    }
    try {
      const row = await updateAgent(userId, agentId, {
        name: patch.name,
        persona: personaOf(patch.persona),
        budgetMinor,
        state: patch.state,
      });
      if (!row) throw notFound('agent not found');
      return context.json(toAgentView(row));
    } catch (error) {
      if (isNameTaken(error)) throw nameTaken();
      if (isBudgetCutAfterTrade(error)) throw budgetCutAfterTrade();
      throw error;
    }
  });
}
