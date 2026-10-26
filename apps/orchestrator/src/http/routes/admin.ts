/**
 * The admin surface (M8). Operations views of the installation as a whole, as
 * opposed to one account's portfolio.
 *
 * No route here checks the role: `app.ts` gates every path under `/admin`
 * before any of these handlers run, and `adminGuard.test.ts` enumerates the
 * registered routes to prove it. A route added here is guarded by being here.
 */

import { randomBytes } from 'node:crypto';

import type { Context, Hono } from 'hono';
import { z } from 'zod';

import { AiServiceError, type LlmModelsResponse } from '@traders/shared/ai';
import {
  type AdminAuditResponse,
  type AdminLlmModelsResponse,
  type LlmModelChoiceInput,
  type AdminRunsResponse,
  type AdminSettingsResponse,
  type AdminSignupsResponse,
  type AdminUsersResponse,
  type AdminUserView,
  type OneTimePasswordResponse,
  type SignupDecisionResponse,
  type SignupRequestView,
  ASSISTANT_DAILY_BUDGET_CEILING_MICRO_USD,
  MAX_AGENTS_PER_USER_CEILING,
  MAX_PENDING_SIGNUPS_CEILING,
  SIGNUP_MODES,
  DAILY_NEW_ACCOUNTS_CEILING,
  type RescreenStartResponse,
  type UniverseGapsResponse,
} from '@traders/shared';

import {
  approveSignup,
  countNarrationFallbacks,
  countPendingSignups,
  listSignupRequests,
  rejectSignup,
  restoreSignup,
  type SignupDecision,
  type SignupRequestRow,
  type AdminUserRow,
  listUsersForAdmin,
  setOneTimePassword,
  setUserStatus,
  countUniverse,
  firstLlmCallAt,
  chooseLlmModel,
  getInstallationSettings,
  setAssistantDailyBudget,
  setMaxAgentsPerUser,
  setMaxPendingSignups,
  setSignupMode,
  setDailyNewAccountsLimit,
  getLatestUniverseLoad,
  groupLlmCalls,
  listAdminAudit,
  listAllRuns,
  listLlmCalls,
  listOpsEvents,
  llmLatencies,
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
import { hashPassword } from '../password.js';

/** Enough to see a day of the half-hourly scans next to everything else. */
const ADMIN_RUNS_LIMIT = 100;
const ADMIN_AUDIT_LIMIT = 100;
const GAPS_LIMIT = 200;
const GAP_KINDS: readonly OpsEventKind[] = [
  'universe_gap_missing_ticker',
  'universe_gap_low_confidence',
];

const settingsSchema = z
  .object({
    maxAgentsPerUser: z.number().int().min(1).max(MAX_AGENTS_PER_USER_CEILING).optional(),
    assistantDailyBudgetMicroUsd: z
      .number()
      .int()
      .min(0)
      .max(ASSISTANT_DAILY_BUDGET_CEILING_MICRO_USD)
      .optional(),
    maxPendingSignups: z.number().int().min(0).max(MAX_PENDING_SIGNUPS_CEILING).optional(),
    signupMode: z.enum(SIGNUP_MODES).optional(),
    dailyNewAccountsLimit: z.number().int().min(0).max(DAILY_NEW_ACCOUNTS_CEILING).optional(),
  })
  .strict()
  .refine((input) => Object.keys(input).length > 0, { message: 'name at least one setting' });

async function adminSettings(emailConfigured: boolean): Promise<AdminSettingsResponse> {
  const row = await getInstallationSettings();
  return {
    maxAgentsPerUser: row.max_agents_per_user,
    assistantDailyBudgetMicroUsd: row.assistant_daily_budget_micro_usd,
    maxPendingSignups: row.max_pending_signups,
    signupMode: row.signup_mode,
    dailyNewAccountsLimit: row.daily_new_accounts_limit,
    emailConfigured,
    updatedAt: row.updated_at.toISOString(),
  };
}

const uuidParam = z.string().uuid();

/** 120 random bits as 20 URL-safe characters: past the length rule, easy to read aloud in groups. */
export function oneTimePassword(): string {
  return randomBytes(15).toString('base64url');
}

function adminUserView(row: AdminUserRow): AdminUserView {
  return {
    userId: row.id,
    email: row.email,
    role: row.role,
    status: row.status,
    timezone: row.timezone,
    spentThisMonthMicroUsd: Number(row.spent_this_month_micro_usd),
    ownKey: row.own_key_status ?? 'none',
    lastSignInAt: row.last_sign_in_at ? row.last_sign_in_at.toISOString() : null,
    approvedAt: row.approved_at ? row.approved_at.toISOString() : null,
  };
}

function signupView(row: SignupRequestRow): SignupRequestView {
  return {
    userId: row.user_id,
    email: row.email,
    timezone: row.timezone,
    status: row.status,
    requestedAt: row.created_at.toISOString(),
  };
}

function decisionBody(decision: SignupDecision): SignupDecisionResponse {
  return { applied: decision.applied, status: decision.status };
}

/** The request a decision names; a malformed id is no request at all. */
function signupId(context: Context<AppEnv>): string {
  const parsed = uuidParam.safeParse(context.req.param('userId'));
  if (!parsed.success) throw badRequest('invalid_user_id', 'expected a user id');
  return parsed.data;
}

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
   * The user list (D162): status, this month's spend, own key, last sign-in.
   * Operations only - never an account's holdings, proposals, agents or
   * conversations.
   */
  app.get('/admin/users', async (context) => {
    const body: AdminUsersResponse = { users: (await listUsersForAdmin()).map(adminUserView) };
    return context.json(body);
  });

  /**
   * Disable a user (D239): their sessions end at once (D160), scheduled work
   * skips them (D161), their data stays. Re-enable lets them back in as they
   * were. Never the admin's own row. Audited by the gate before this runs.
   */
  app.post('/admin/users/:userId/disable', async (context) => {
    const changed = await setUserStatus(signupId(context), 'active', 'disabled');
    if (!changed) throw conflict('not_disableable', 'only an active user who is not the admin can be disabled');
    return context.json({ userId: changed.id, status: 'disabled' });
  });

  app.post('/admin/users/:userId/enable', async (context) => {
    const changed = await setUserStatus(signupId(context), 'disabled', 'active');
    if (!changed) throw conflict('not_enableable', 'only a disabled user can be enabled');
    return context.json({ userId: changed.id, status: 'active' });
  });

  /**
   * A forgotten password (D162, D239): the app makes a one-time password,
   * stores its hash, ends the user's sessions, and answers it here once for the
   * admin to pass on. The audit records the request, which carries no password.
   */
  app.post('/admin/users/:userId/one-time-password', async (context) => {
    const userId = signupId(context);
    const password = oneTimePassword();
    const changed = await setOneTimePassword(userId, await hashPassword(password));
    if (!changed) throw conflict('no_one_time_password', 'only an approved user who is not the admin');
    context.header('cache-control', 'no-store');
    const body: OneTimePasswordResponse = { userId: changed.id, password };
    return context.json(body);
  });

  /**
   * Sign-up requests (D156, D188): waiting ones oldest first, then recent
   * rejections, which can be undone. Email and zone only - never anything of
   * the account itself (D162).
   */
  app.get('/admin/signups', async (context) => {
    const requests = await listSignupRequests();
    const body: AdminSignupsResponse = {
      pending: requests.pending.map(signupView),
      rejected: requests.rejected.map(signupView),
    };
    return context.json(body);
  });

  /** The count on the Admin link (D188). */
  app.get('/admin/signups/count', async (context) => context.json({ pending: await countPendingSignups() }));

  /**
   * Decide a request. Each is conditional on the state it starts from, so a
   * request already decided from Telegram answers `applied: false` with where
   * it is now, rather than an error. Audited by the gate before this runs.
   */
  app.post('/admin/signups/:userId/approve', async (context) => {
    const userId = signupId(context);
    // No amount: a user runs on their own key only (D245), and the retired monthly
    // cap keeps its column's CHECK satisfied with the installation's default (D279).
    const { default_llm_cap_micro_usd: retiredCap } = await getInstallationSettings();
    return context.json(decisionBody(await approveSignup(userId, retiredCap, currentUserId(context))));
  });

  app.post('/admin/signups/:userId/reject', async (context) =>
    context.json(decisionBody(await rejectSignup(signupId(context)))),
  );

  /** Undo a rejection: the request waits again (D188). */
  app.post('/admin/signups/:userId/restore', async (context) =>
    context.json(decisionBody(await restoreSignup(signupId(context)))),
  );

  /** The installation's settings (D72). */
  app.get('/admin/settings', async (context) =>
    context.json(await adminSettings(context.get('config').emailConfigured)),
  );

  /**
   * Change them. Audited by the gate before this runs (decision 84). A lower
   * limit refuses nothing that exists: it stops the next create (0047).
   */
  app.put('/admin/settings', async (context) => {
    const parsed = settingsSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      throw badRequest(
        'invalid_body',
        `expected { maxAgentsPerUser?: 1-${MAX_AGENTS_PER_USER_CEILING}, ` +
          `assistantDailyBudgetMicroUsd?: 0-${ASSISTANT_DAILY_BUDGET_CEILING_MICRO_USD}, ` +
          `maxPendingSignups?: 0-${MAX_PENDING_SIGNUPS_CEILING}, signupMode?: ${SIGNUP_MODES.join(' | ')}, ` +
          `dailyNewAccountsLimit?: 0-${DAILY_NEW_ACCOUNTS_CEILING} }`,
        parsed.error.issues,
      );
    }
    const admin = currentUserId(context);
    if (parsed.data.maxAgentsPerUser !== undefined) await setMaxAgentsPerUser(parsed.data.maxAgentsPerUser, admin);
    if (parsed.data.assistantDailyBudgetMicroUsd !== undefined) {
      await setAssistantDailyBudget(parsed.data.assistantDailyBudgetMicroUsd, admin);
    }
    if (parsed.data.maxPendingSignups !== undefined) await setMaxPendingSignups(parsed.data.maxPendingSignups, admin);
    if (parsed.data.signupMode !== undefined) {
      // *Automatic* lets people in by their verified address: with no mail, nobody could ever arrive (D259).
      if (parsed.data.signupMode === 'automatic' && !context.get('config').emailConfigured) {
        throw unprocessable('email_unavailable', 'automatic sign-up needs outbound mail (SMTP_HOST and EMAIL_FROM)');
      }
      await setSignupMode(parsed.data.signupMode, admin);
    }
    if (parsed.data.dailyNewAccountsLimit !== undefined) {
      await setDailyNewAccountsLimit(parsed.data.dailyNewAccountsLimit, admin);
    }
    return context.json(await adminSettings(context.get('config').emailConfigured));
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
