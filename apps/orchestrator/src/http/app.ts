/**
 * HTTP application: middleware stack and route mounting.
 *
 * Cross-cutting concerns live here so no individual route has to remember them:
 * request ids, access logs, CORS, origin checking for state-changing requests,
 * session resolution and the single error shape.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { getCookie } from 'hono/cookie';
import { randomUUID } from 'node:crypto';

import type { AiClient } from '@traders/shared/ai';

import type { ScanQueue } from '../services/scheduledScans.js';
import { buildNotifier } from '../notify/factory.js';
import type { Notifier } from '../notify/notifier.js';

import type { Config } from '../config.js';
import { logger } from '../logger.js';
import { SESSION_COOKIE, verifySessionToken } from './auth.js';
import { memoryRateLimits, type RateLimits } from './rateLimits.js';
import { getUser, insertAdminAudit, type UserRow } from '../db/queries.js';
import { auditEntry } from './adminAudit.js';
import { forbidden, toErrorResponse, unauthorized, ApiProblem } from './errors.js';
import { registerAccountRoutes } from './routes/account.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerAgentAccountRoutes } from './routes/agentAccount.js';
import { registerAgentScanRoutes } from './routes/agentScans.js';
import { registerAgentsRoutes } from './routes/agents.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAssistantRoutes } from './routes/assistant.js';
import { registerConceptsRoutes } from './routes/concepts.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerHoldingsRoutes } from './routes/holdings.js';
import { registerImportRoutes } from './routes/imports.js';
import { registerInternalRoutes } from './routes/internal.js';
import {
  registerAlertsRoute,
  registerDigestRoute,
  registerNotificationsRoutes,
} from './routes/notifications.js';
import { registerPortfolioRoutes } from './routes/portfolio.js';
import { registerProposalsRoutes } from './routes/proposals.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerTelegramRoutes } from '../telegram/webhook.js';
import { registerTargetsRoutes } from './routes/targets.js';
import { registerResearchRoutes } from './routes/research.js';
import { registerInstructionsCheckRoutes } from './routes/instructionsCheck.js';
import { registerTaxonomyRoutes } from './routes/taxonomy.js';
import { registerTradesRoutes } from './routes/trades.js';
import { registerTopicsRoutes } from './routes/topics.js';

export interface AppEnv {
  Variables: {
    requestId: string;
    userId?: string;
    /** The signed-in user, read once per request by the session middleware (D160). */
    user?: UserRow;
    config: Config;
    ai: AiClient;
    notifier: Notifier;
    /** Null where scheduled scans are off (D71): the ask then does nothing. */
    scanQueue: ScanQueue | null;
    /** How often a caller may do what costs money or shared quota (D257). */
    rateLimits: RateLimits;
  };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Route prefixes that require a signed-in session. */
const PROTECTED_PREFIXES = [
  '/portfolio',
  '/holdings',
  '/agents',
  '/imports',
  '/runs',
  '/observations',
  // Shared reference material with no `user_id`, but still behind the gate: the
  // corpus is part of the product, not a public API, and an unauthenticated
  // reader has no observation to have arrived from.
  '/concepts',
  '/targets',
  // Like '/concepts': the universe has no `user_id`, and is still the product.
  '/topics',
  '/proposals',
  // The assistant's questions and the conversations they make (migration 0052).
  '/assistant',
  '/notifications',
  '/settings',
  // The user's own account: its reset (D162).
  '/account',
  // Named individually, not as '/telegram': POST /telegram/webhook is called by
  // Telegram and must stay unauthenticated - it proves itself with the secret
  // header instead. A blanket prefix here would 401 every inbound update, and
  // the symptom would be a bot that silently never responds.
  '/telegram/bind-token',
  '/telegram/binding',
];

/**
 * The admin surface. Every route under it is reached only through `adminGuard`
 * below, which is why no admin route checks the role itself: a check that each
 * route must remember is one route away from being forgotten.
 */
export const ADMIN_PREFIX = '/admin';

/** The two write paths whose callers are not browsers and authenticate with a secret instead. */
const TELEGRAM_WEBHOOK_PATH = '/telegram/webhook';

function isNotFromABrowser(path: string): boolean {
  return path.startsWith('/internal/') || path === TELEGRAM_WEBHOOK_PATH;
}

export function isAdminPath(path: string): boolean {
  return path === ADMIN_PREFIX || path.startsWith(`${ADMIN_PREFIX}/`);
}

/**
 * `notifier` is injectable so a test can assert what would have been sent
 * without a bot token, and defaults to whatever the configuration describes -
 * which, with no token set, is a channel that declines with the reason.
 * `rateLimits` counts in memory unless given Redis's (`server.ts` does), so a
 * test never needs a Redis.
 */
export function createApp(
  config: Config,
  ai: AiClient,
  notifier: Notifier = buildNotifier(config),
  scanQueue: ScanQueue | null = null,
  rateLimits: RateLimits = memoryRateLimits(),
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', async (context, next) => {
    const requestId = context.req.header('x-request-id') ?? randomUUID();
    context.set('requestId', requestId);
    context.set('config', config);
    context.set('ai', ai);
    context.set('notifier', notifier);
    context.set('scanQueue', scanQueue);
    context.set('rateLimits', rateLimits);
    context.header('x-request-id', requestId);
    const startedAt = Date.now();
    await next();
    logger().info(
      {
        requestId,
        method: context.req.method,
        path: context.req.path,
        status: context.res.status,
        durationMs: Date.now() - startedAt,
      },
      'request',
    );
  });

  app.use(
    '*',
    cors({
      origin: config.allowedOrigins,
      credentials: true,
      allowHeaders: ['content-type', 'x-request-id'],
      // PUT belongs here because two routes use it (`/targets`, `/settings`).
      // Its absence was invisible from the server side - a preflight for a
      // method the browser was not told about fails in the browser, so the
      // request never arrives and the log shows nothing at all.
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    }),
  );

  /**
   * CSRF defence: the session cookie is SameSite=Lax, and every state-changing
   * request must additionally carry an Origin we recognise - a missing one
   * included (D256): a browser sends Origin with every POST, PUT, PATCH and
   * DELETE, same-origin ones too, so a write without it did not come from our
   * page. Two callers are not browsers and prove themselves otherwise:
   * /internal/* with the shared key, and Telegram's webhook with its secret
   * header.
   */
  app.use('*', async (context, next) => {
    if (SAFE_METHODS.has(context.req.method) || isNotFromABrowser(context.req.path)) {
      return next();
    }
    const origin = context.req.header('origin');
    if (!origin) throw new ApiProblem(403, 'missing_origin', 'a state-changing request must carry an Origin header');
    if (!config.allowedOrigins.includes(origin)) {
      throw new ApiProblem(403, 'bad_origin', `origin ${origin} is not allowed`);
    }
    return next();
  });

  /**
   * Resolve the session for every request; individual routes decide if it is
   * required. A valid cookie is not enough (D160): the user is read by primary
   * key and the session holds only while they are `active` and their
   * `session_version` is still the cookie's, so disabling a user or changing a
   * password ends a session on its next request. A request without a cookie
   * costs no read.
   */
  app.use('*', async (context, next) => {
    const claim = verifySessionToken(getCookie(context, SESSION_COOKIE), config.SESSION_SECRET);
    if (claim) {
      const user = await getUser(claim.userId);
      if (user && user.status === 'active' && user.session_version === claim.sessionVersion) {
        context.set('userId', user.id);
        context.set('user', user);
      }
    }
    return next();
  });

  app.onError((error, context) => {
    const { body, status, headers } = toErrorResponse(error, context);
    if (status >= 500) {
      logger().error({ err: error, requestId: body.requestId }, 'unhandled error');
    } else {
      logger().warn({ err: error, requestId: body.requestId, status }, 'request rejected');
    }
    return context.json(body, status as 400, headers);
  });

  app.notFound((context) =>
    context.json(
      { error: 'not_found', message: `no route for ${context.req.method} ${context.req.path}` },
      404,
    ),
  );

  /**
   * Session gate. Applied by path prefix rather than by mounting a wildcard
   * sub-router: a catch-all guard would answer every unknown path with 401,
   * hiding real 404s and shadowing /internal/*.
   */
  app.use('*', async (context, next) => {
    const path = context.req.path;
    const isProtected = PROTECTED_PREFIXES.some(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`),
    );
    if (!isProtected && !isAdminPath(path)) return next();
    const user = context.get('user');
    if (!user) throw unauthorized();
    // The admin's one-time password (D162): until it is changed, the account
    // can do nothing but change it - `/auth/*` is outside both gates.
    if (user.password_must_change) {
      throw new ApiProblem(403, 'password_change_required', 'set a new password first');
    }
    return next();
  });

  /**
   * Admin gate: 401 without a session, 403 for a session whose user is not an
   * admin. The role is read from `users` on every request rather than carried
   * in the cookie (decision 83): the cookie lives for days, so a role copied
   * into it would survive a demotion until it expired. The read is the session
   * middleware's, which every signed-in request already makes (D160).
   *
   * Unknown paths under the prefix are gated too, so a signed-out probe of
   * `/admin/anything` learns nothing about which admin routes exist.
   */
  app.use('*', async (context, next) => {
    if (!isAdminPath(context.req.path)) return next();
    const user = context.get('user');
    if (!user) throw unauthorized();
    if (user.role !== 'admin') throw forbidden('this account is not an administrator');
    // Every admin request that can change something is recorded before it
    // runs, and does not run if the record cannot be written (decision 84).
    // Here rather than in each route for the same reason as the role check:
    // a new admin action is audited by being an admin route.
    if (!SAFE_METHODS.has(context.req.method)) {
      const entry = await auditEntry(context);
      await insertAdminAudit({
        adminUserId: user.id,
        action: entry.action,
        detail: entry.detail,
        ipAddress: entry.ipAddress,
        requestId: context.get('requestId'),
      });
    }
    return next();
  });

  registerHealthRoutes(app);
  registerAuthRoutes(app);
  registerAccountRoutes(app);
  registerPortfolioRoutes(app);
  registerHoldingsRoutes(app);
  registerAgentsRoutes(app);
  registerTradesRoutes(app);
  registerAgentAccountRoutes(app);
  registerAgentScanRoutes(app);
  registerTargetsRoutes(app);
  registerProposalsRoutes(app);
  registerNotificationsRoutes(app);
  registerDigestRoute(app);
  registerAlertsRoute(app);
  registerSettingsRoutes(app);
  registerTelegramRoutes(app);
  registerImportRoutes(app);
  registerConceptsRoutes(app);
  registerAssistantRoutes(app);
  registerTopicsRoutes(app);
  registerTaxonomyRoutes(app);
  registerInstructionsCheckRoutes(app);
  registerResearchRoutes(app);
  registerInternalRoutes(app);
  registerAdminRoutes(app);

  return app;
}

/** The authenticated user id, guaranteed present inside the protected router. */
export function currentUserId(context: { get: (key: 'userId') => string | undefined }): string {
  const userId = context.get('userId');
  if (!userId) throw unauthorized();
  return userId;
}
