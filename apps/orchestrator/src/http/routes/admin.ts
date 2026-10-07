/**
 * The admin surface (M8). Operations views of the installation as a whole, as
 * opposed to one account's portfolio.
 *
 * No route here checks the role: `app.ts` gates every path under `/admin`
 * before any of these handlers run, and `adminGuard.test.ts` enumerates the
 * registered routes to prove it. A route added here is guarded by being here.
 */

import type { Context, Hono } from 'hono';
import { z } from 'zod';

import { AiServiceError, type LlmModelsResponse } from '@traders/shared/ai';
import {
  ACCOUNT_RESET_CONFIRMATION,
  ACCOUNT_RESET_GROUPS,
  type AccountResetInput,
  type AccountResetResponse,
  type AdminAuditResponse,
  type AdminLlmModelsResponse,
  type LlmModelChoiceInput,
  type AdminRunsResponse,
  type RescreenStartResponse,
  type UniverseGapsResponse,
} from '@traders/shared';

import {
  countNarrationFallbacks,
  countUniverse,
  firstLlmCallAt,
  chooseLlmModel,
  getLatestUniverseLoad,
  groupLlmCalls,
  listAdminAudit,
  listAllRuns,
  listLlmCalls,
  listOpsEvents,
  llmLatencies,
  resetAccount,
  type OpsEventKind,
} from '../../db/queries.js';
import {
  LLM_PANEL_MAX_DAYS,
  LLM_PANEL_RECENT_LIMIT,
  llmPanel,
  parseWindowDays,
  reconciliationSince,
} from '../../services/llmPanel.js';
import { choiceRefusal, isLlmScope, LLM_SCOPES, toAdminLlmModels } from '../../services/llmModels.js';
import { startRescreen } from '../../services/universeRescreen.js';
import { universeStatus } from '../../services/universeStatus.js';
import { currentUserId, type AppEnv } from '../app.js';
import { badRequest, conflict, unprocessable, upstreamFailure } from '../errors.js';

/** Enough to see a day of the half-hourly scans next to everything else. */
const ADMIN_RUNS_LIMIT = 100;
const ADMIN_AUDIT_LIMIT = 100;
const GAPS_LIMIT = 200;
const GAP_KINDS: readonly OpsEventKind[] = [
  'universe_gap_missing_ticker',
  'universe_gap_low_confidence',
];

const resetSchema = z
  .object({
    groups: z.array(z.enum(ACCOUNT_RESET_GROUPS)).min(1),
    confirm: z.string(),
  })
  .strict() satisfies z.ZodType<AccountResetInput>;

const modelChoiceSchema = z
  .object({ model: z.string().trim().min(1).max(200) })
  .strict() satisfies z.ZodType<LlmModelChoiceInput>;

/** The AI service's catalogue; its failure is the page's "could not be read", not a 500. */
async function llmCatalogue(context: Context<AppEnv>): Promise<LlmModelsResponse> {
  try {
    return await context.get('ai').llmModels(context.get('requestId'));
  } catch (error) {
    if (error instanceof AiServiceError) {
      throw upstreamFailure(error.status, 'The AI service could not list the models.');
    }
    throw error;
  }
}

export function registerAdminRoutes(app: Hono<AppEnv>): void {
  /**
   * Every run of every account and of none, newest first. `GET /runs` is one
   * account's history; this is the installation's, including the runs a
   * CronJob started for no user in particular.
   */
  app.get('/admin/runs', async (context) => {
    const kind = context.req.query('kind');
    if (kind !== undefined && !/^[a-z_]{1,64}$/.test(kind)) {
      throw badRequest('invalid_kind', 'kind is a run kind such as portfolio_scan');
    }
    const rows = await listAllRuns(kind, ADMIN_RUNS_LIMIT);
    const body: AdminRunsResponse = {
      runs: rows.map((row) => ({
        id: row.id,
        userId: row.user_id,
        kind: row.kind,
        runKey: row.run_key,
        trigger: row.trigger,
        status: row.status,
        startedAt: new Date(row.started_at).toISOString(),
        finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
      })),
    };
    return context.json(body);
  });

  /** The admin actions taken, newest first, as recorded before each one ran. */
  app.get('/admin/audit', async (context) => {
    const rows = await listAdminAudit(ADMIN_AUDIT_LIMIT);
    const body: AdminAuditResponse = {
      entries: rows.map((row) => ({
        id: row.id,
        adminUserId: row.admin_user_id,
        action: row.action,
        detail: row.detail,
        ipAddress: row.ip_address,
        requestId: row.request_id,
        occurredAt: new Date(row.occurred_at).toISOString(),
      })),
    };
    return context.json(body);
  });

  /**
   * Gaps between what users asked for and what the universe holds, most
   * recently seen first, each counted rather than repeated.
   */
  app.get('/admin/gaps', async (context) => {
    const kind = context.req.query('kind');
    if (kind !== undefined && !GAP_KINDS.includes(kind as OpsEventKind)) {
      throw badRequest('invalid_kind', `kind is one of ${GAP_KINDS.join(', ')}`);
    }
    const rows = await listOpsEvents(kind as OpsEventKind | undefined, GAPS_LIMIT);
    const body: UniverseGapsResponse = {
      gaps: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        userId: row.user_id,
        detail: (row.detail ?? {}) as Record<string, unknown>,
        occurrences: row.occurrences,
        firstSeenAt: new Date(row.occurred_at).toISOString(),
        lastSeenAt: new Date(row.last_seen_at).toISOString(),
        profile: row.profile_membership,
      })),
    };
    return context.json(body);
  });

  /**
   * The universe: what the snapshot says, what the database holds, and every
   * difference between them either named by the loader or flagged.
   */
  app.get('/admin/universe', async (context) => {
    const [load, counts] = await Promise.all([getLatestUniverseLoad(), countUniverse()]);
    return context.json(universeStatus(load, counts));
  });

  /**
   * Every model call over the last `days` (default 7), per purpose, with
   * narration's fallback reasons counted beside the calls behind them.
   */
  app.get('/admin/llm', async (context) => {
    const days = parseWindowDays(context.req.query('days'));
    if (days === null) {
      throw badRequest('invalid_days', `days is a whole number from 1 to ${LLM_PANEL_MAX_DAYS}`);
    }
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const firstCallAt = await firstLlmCallAt();
    const overlap = reconciliationSince(since, firstCallAt);
    const [groups, latencies, fallbacks, reconciledFallbacks, recent] = await Promise.all([
      groupLlmCalls(since),
      llmLatencies(since),
      countNarrationFallbacks(since),
      overlap ? countNarrationFallbacks(overlap) : Promise.resolve([]),
      listLlmCalls(LLM_PANEL_RECENT_LIMIT),
    ]);
    return context.json(
      llmPanel({ days, since, firstCallAt, groups, latencies, fallbacks, reconciledFallbacks, recent }),
    );
  });

  /**
   * The models narration, `/ask` and agents may use, what each would cost, and
   * the provider account's balance (D43, D44).
   */
  app.get('/admin/llm/models', async (context) => {
    const body: AdminLlmModelsResponse = toAdminLlmModels(await llmCatalogue(context));
    return context.json(body);
  });

  /**
   * Choose the model for a scope (D43). Audited by the gate before this runs
   * (decision 84); refused unless the AI service offers the model for that
   * scope, so the page and this check read one list. Answers the page afresh.
   */
  app.put('/admin/llm/models/:scope', async (context) => {
    const scope = context.req.param('scope');
    if (!isLlmScope(scope)) throw badRequest('invalid_scope', `scope is one of ${LLM_SCOPES.join(', ')}`);
    const parsed = modelChoiceSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) throw badRequest('invalid_body', 'expected { model }', parsed.error.issues);
    const refusal = choiceRefusal(await llmCatalogue(context), scope, parsed.data.model);
    if (refusal) {
      throw refusal.code === 'models_not_choosable'
        ? conflict(refusal.code, refusal.message)
        : unprocessable(refusal.code, refusal.message);
    }
    await chooseLlmModel(scope, parsed.data.model, currentUserId(context));
    const body: AdminLlmModelsResponse = toAdminLlmModels(await llmCatalogue(context));
    return context.json(body);
  });

  /**
   * Reset the account, by group (task 18). Erases the chosen groups of the
   * signed-in account and keeps a backup of every erased row, in one
   * transaction inside the database (`reset_account`, migration 0045). Audited
   * by the gate before this runs (decision 84). The typed word is checked here
   * as well as on the page: a request that skipped the page has not confirmed.
   */
  app.post('/admin/account/reset', async (context) => {
    const parsed = resetSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      throw badRequest('invalid_body', `expected { groups: (${ACCOUNT_RESET_GROUPS.join(' | ')})[], confirm }`, parsed.error.issues);
    }
    if (parsed.data.confirm !== ACCOUNT_RESET_CONFIRMATION) {
      throw unprocessable('reset_not_confirmed', `type ${ACCOUNT_RESET_CONFIRMATION} to confirm a reset`);
    }
    const groups = ACCOUNT_RESET_GROUPS.filter((group) => parsed.data.groups.includes(group));
    const reset = await resetAccount(currentUserId(context), groups);
    const body: AccountResetResponse = { resetId: reset.reset_id, groups, erased: reset.counts };
    return context.json(body);
  });

  /**
   * Rescreen the universe now. Audited by the gate before this runs (decision
   * 84), and the same run as the quarterly CronJob's on the same day.
   */
  app.post('/admin/universe/rescreen', async (context) => {
    const started = await startRescreen(context.get('ai'), {
      timezone: context.get('config').APP_TIMEZONE,
      trigger: 'admin',
      requestId: context.get('requestId'),
    });
    const body: RescreenStartResponse = started;
    return context.json(body, started.status === 'running' ? 202 : 200);
  });
}
