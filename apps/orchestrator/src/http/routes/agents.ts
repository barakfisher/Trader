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

import {
  HORIZON_MAX_DECISIONS,
  HORIZON_SCHEDULES,
  MAX_DECISIONS_PER_SCAN,
  MAX_SCAN_EVERY_HOURS,
  MIN_DECISIONS_PER_SCAN,
  MIN_SCAN_EVERY_HOURS,
  type AgentView,
  type AgentsResponse,
  type ModelChoicesResponse,
  type ScanSchedule,
} from '@traders/shared';

import { schedulingOf } from '../../services/agentScheduling.js';
import { scanCostOf } from '../../services/scanCost.js';

// The estimate's home is the service; re-exported for the route's own tests.
export { MEASURED_SCAN_COST_MICRO_USD, scanCostOf } from '../../services/scanCost.js';
import { scheduleOf } from '../../services/scanSchedule.js';
import { readyToScan } from '../../services/agentReadiness.js';
import {
  activeLimitFor,
  assertRoomToActivate,
  assertRoomToKeep,
  CHECK_VIOLATION,
  limitAfter,
} from '../../services/agentControl.js';
import { currentConflicts } from '../../services/instructionsCheck.js';
import { modelChoiceRefusal, modelChoiceSchema, readModelChoices, relayModels } from '../../services/modelChoices.js';

import {
  agentHasTraded,
  createAgent,
  getAgent,
  listAgents,
  setAgentModel,
  updateAgent,
  type AgentRow,
  type UserRow,
} from '../../db/queries.js';
import {
  EMPTY_MANDATE,
  assertKnownClassifications,
  mandateSchema,
  toMandateColumns,
  toMandateView,
} from '../agentMandate.js';
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

/** Migration 0060's default: what an agent with neither a schedule nor a horizon gets - before the open. */
export const DEFAULT_SCHEDULE: ScanSchedule = { everyHours: null, preOpen: true, postClose: false };

/** D45's ceiling, as migration 0042's CHECK has it: $100 a day. */
export const MAX_LLM_BUDGET_MICRO_USD = 100_000_000;


/** Dollars and cents, no more: a third decimal would round on the way in. */
export const BUDGET_PATTERN = /^\d+(\.\d{1,2})?$/;

const UNIQUE_VIOLATION = '23505';

const name = z.string().trim().min(1).max(MAX_NAME_LENGTH);
const budget = z.string().trim().regex(BUDGET_PATTERN, 'budget must be an amount in dollars, at most two decimal places');
const persona = z.string().trim().max(MAX_PERSONA_LENGTH).nullable();
/** D195: all three parts, always - a schedule is replaced whole, never merged. All off is manual only. */
const scanSchedule = z
  .object({
    everyHours: z.number().int().min(MIN_SCAN_EVERY_HOURS).max(MAX_SCAN_EVERY_HOURS).nullable(),
    preOpen: z.boolean(),
    postClose: z.boolean(),
  })
  .strict();
/** D197: trades one scan may decide, each a proposal the user approves. */
const maxDecisions = z.number().int().min(MIN_DECISIONS_PER_SCAN).max(MAX_DECISIONS_PER_SCAN);

const createSchema = z
  .object({
    name,
    budget,
    persona: persona.optional(),
    mandate: mandateSchema.optional(),
    scanSchedule: scanSchedule.optional(),
    maxDecisions: maxDecisions.optional(),
    // D200: at the limit the page creates it paused, which is never refused.
    state: z.enum(['active', 'paused']).optional(),
  })
  .strict();
const patchSchema = z
  .object({
    name: name.optional(),
    budget: budget.optional(),
    persona: persona.optional(),
    state: z.enum(['active', 'paused', 'archived']).optional(),
    llmBudget: budget.optional(),
    scanSchedule: scanSchedule.optional(),
    maxDecisions: maxDecisions.optional(),
    mandate: mandateSchema.optional(),
  })
  .strict();

/** A daily model allowance from dollars and cents, in micro-USD (D45). */
export function llmBudgetToMicroUsd(text: string): number {
  const [whole, fraction = ''] = text.split('.');
  const micro = (Number(whole) * 100 + Number(fraction.padEnd(2, '0'))) * 10_000;
  if (!Number.isSafeInteger(micro) || micro <= 0 || micro > MAX_LLM_BUDGET_MICRO_USD) {
    throw unprocessable(
      'llm_budget_out_of_range',
      `a model budget must be more than $0 and at most $${MAX_LLM_BUDGET_MICRO_USD / 1_000_000} a day`,
    );
  }
  return micro;
}


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
    cashMinor: row.cash_minor == null ? null : Number(row.cash_minor),
    currency: row.currency,
    state: row.state,
    holdingsCount: row.holdings_count,
    createdAt: row.created_at.toISOString(),
    // The primary never scans (D1): none of this describes it.
    scanSchedule: row.is_primary ? null : scheduleOf(row),
    maxDecisions: row.is_primary ? null : row.max_decisions,
    runningScan:
      row.is_primary || !row.running_scan
        ? null
        : { trigger: row.running_scan.trigger, startedAt: new Date(row.running_scan.started_at).toISOString() },
    llmBudgetMicroUsd: row.is_primary ? null : Number(row.llm_budget_micro_usd),
    llmSpentTodayMicroUsd: row.is_primary ? null : Number(row.llm_spent_today_micro_usd),
    scanCost: row.is_primary ? null : scanCostOf(row),
    waitingForBrief: !row.is_primary && row.state === 'active' && !readyToScan(row),
    mandate: toMandateView(row),
    instructionsConflicts: row.is_primary ? null : currentConflicts(row),
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
export function agentIdFrom(raw: string): string {
  if (!z.string().uuid().safeParse(raw).success) throw notFound('agent not found');
  return raw;
}

const nameTaken = () => conflict('agent_name_taken', 'you already have an agent with that name');

export function registerAgentsRoutes(app: Hono<AppEnv>): void {
  app.get('/agents', async (context) => {
    const rows = await listAgents(currentUserId(context));
    const max = await activeLimitFor(context.get('user'));
    const live = rows.filter((row) => !row.is_primary && row.state !== 'archived');
    const used = live.filter((row) => row.state === 'active').length;
    // D202: the ceiling is the admin's to ignore, like the limit (D201).
    const total = max === null ? null : live.length;
    const body: AgentsResponse = { agents: rows.map(toAgentView), agentLimit: { used, max, total } };
    return context.json(body);
  });

  app.get('/agents/:id', async (context) => {
    const row = await getAgent(currentUserId(context), agentIdFrom(context.req.param('id')));
    if (!row) throw notFound('agent not found');
    if (row.is_primary) return context.json(toAgentView(row));
    const scheduling = await schedulingOf(
      row,
      context.get('config').ENABLE_SCHEDULED_SCANS,
      context.get('ai'),
      context.get('requestId'),
    );
    return context.json({ ...toAgentView(row), scheduling } satisfies AgentView);
  });

  app.post('/agents', async (context) => {
    const parsed = createSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      throw badRequest('invalid_body', 'expected { name, budget, persona?, mandate?, scanSchedule?, maxDecisions?, state? }', parsed.error.issues);
    }
    const input = parsed.data;
    const budgetMinor = budgetToMinor(input.budget);
    const mandate = { ...EMPTY_MANDATE, ...toMandateColumns(input.mandate ?? {}) };
    await assertKnownClassifications(mandate);
    const state = input.state ?? 'active';
    await assertRoomToKeep(currentUserId(context), context.get('user'));
    if (state === 'active') await assertRoomToActivate(currentUserId(context), context.get('user'));
    try {
      const row = await createAgent({
        userId: currentUserId(context),
        // The slug is an identity, not a label: random, so a renamed agent keeps
        // it, and a name in any script makes one. `primary-portfolio` is the
        // primary's and cannot collide with this shape.
        slug: `agent-${randomUUID().slice(0, 8)}`,
        name: input.name,
        persona: personaOf(input.persona) ?? null,
        budgetMinor,
        currency: AGENT_CURRENCY,
        // D166: a horizon brings its schedule unless one was chosen.
        scanSchedule:
          input.scanSchedule ?? (input.mandate?.horizon ? HORIZON_SCHEDULES[input.mandate.horizon] : DEFAULT_SCHEDULE),
        // D197: and how many trades a scan may decide.
        maxDecisions:
          input.maxDecisions ??
          (input.mandate?.horizon ? HORIZON_MAX_DECISIONS[input.mandate.horizon] : MIN_DECISIONS_PER_SCAN),
        mandate,
        state,
      });
      return context.json(toAgentView(row), 201);
    } catch (error) {
      if (isNameTaken(error)) throw nameTaken();
      return limitAfter(error);
    }
  });

  app.patch('/agents/:id', async (context) => {
    const userId = currentUserId(context);
    const parsed = patchSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      throw badRequest('invalid_body', 'expected { name?, budget?, persona?, state?, llmBudget?, scanSchedule?, maxDecisions?, mandate? }', parsed.error.issues);
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
    // D199: a resume or a restore into active takes a place; paused or archived never does.
    // D202: a restore takes a place under the ceiling, whichever state it restores to.
    if (existing.state === 'archived' && patch.state !== undefined && patch.state !== 'archived') {
      await assertRoomToKeep(userId, context.get('user'));
    }
    if (patch.state === 'active' && existing.state !== 'active') {
      await assertRoomToActivate(userId, context.get('user'));
    }
    const budgetMinor = patch.budget === undefined ? undefined : budgetToMinor(patch.budget);
    const mandate = patch.mandate === undefined ? undefined : toMandateColumns(patch.mandate);
    if (mandate) await assertKnownClassifications(mandate);
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
        llmBudgetMicroUsd: patch.llmBudget === undefined ? undefined : llmBudgetToMicroUsd(patch.llmBudget),
        scanSchedule: patch.scanSchedule,
        maxDecisions: patch.maxDecisions,
        mandate,
      });
      if (!row) throw notFound('agent not found');
      return context.json(toAgentView(row));
    } catch (error) {
      if (isNameTaken(error)) throw nameTaken();
      if (isBudgetCutAfterTrade(error)) throw budgetCutAfterTrade();
      return limitAfter(error);
    }
  });

  // An agent's own model, from OpenRouter's list (D244, D283). The admin's too
  // (D353): an agent of theirs with none runs on the Admin page's choice. Answers
  // the user's whole model picture, as `PUT /settings/llm-models/:scope` does.
  app.put('/agents/:id/model', async (context) => {
    const userId = currentUserId(context);
    const parsed = modelChoiceSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) throw badRequest('invalid_body', 'expected { model: string | null }', parsed.error.issues);
    const agentId = agentIdFrom(context.req.param('id'));
    const existing = await getAgent(userId, agentId);
    if (!existing) throw notFound('agent not found');
    if (existing.is_primary) throw conflict('primary_agent_is_passive', 'the real portfolio makes no model calls of its own');
    const ai = context.get('ai');
    const refusal = modelChoiceRefusal(await relayModels(() => ai.llmListed(context.get('requestId'))), parsed.data.model);
    if (refusal !== null) throw refusal;
    if (!(await setAgentModel(userId, agentId, parsed.data.model))) throw notFound('agent not found');
    const body: ModelChoicesResponse = await relayModels(() => readModelChoices(ai, userId, context.get('requestId')));
    return context.json(body);
  });
}
