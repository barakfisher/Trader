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

import { buildNotifier } from '../notify/factory.js';
import type { Notifier } from '../notify/notifier.js';

import type { Config } from '../config.js';
import { logger } from '../logger.js';
import { SESSION_COOKIE, verifySessionToken } from './auth.js';
import { toErrorResponse, unauthorized, ApiProblem } from './errors.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerHoldingsRoutes } from './routes/holdings.js';
import { registerImportRoutes } from './routes/imports.js';
import { registerInternalRoutes } from './routes/internal.js';
import { registerNotificationsRoutes } from './routes/notifications.js';
import { registerPortfolioRoutes } from './routes/portfolio.js';
import { registerProposalsRoutes } from './routes/proposals.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerTelegramRoutes } from '../telegram/webhook.js';
import { registerTargetsRoutes } from './routes/targets.js';

export interface AppEnv {
  Variables: {
    requestId: string;
    userId?: string;
    config: Config;
    ai: AiClient;
    notifier: Notifier;
  };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Route prefixes that require a signed-in session. */
const PROTECTED_PREFIXES = [
  '/portfolio',
  '/holdings',
  '/imports',
  '/runs',
  '/observations',
  '/targets',
  '/proposals',
  '/notifications',
  '/settings',
  // Named individually, not as '/telegram': POST /telegram/webhook is called by
  // Telegram and must stay unauthenticated - it proves itself with the secret
  // header instead. A blanket prefix here would 401 every inbound update, and
  // the symptom would be a bot that silently never responds.
  '/telegram/bind-token',
  '/telegram/binding',
];

/**
 * `notifier` is injectable so a test can assert what would have been sent
 * without a bot token, and defaults to whatever the configuration describes -
 * which, with no token set, is a channel that declines with the reason.
 */
export function createApp(
  config: Config,
  ai: AiClient,
  notifier: Notifier = buildNotifier(config),
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', async (context, next) => {
    const requestId = context.req.header('x-request-id') ?? randomUUID();
    context.set('requestId', requestId);
    context.set('config', config);
    context.set('ai', ai);
    context.set('notifier', notifier);
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
   * request must additionally carry an Origin we recognise. Service-to-service
   * calls hit /internal/* and authenticate with the shared key instead.
   */
  app.use('*', async (context, next) => {
    if (SAFE_METHODS.has(context.req.method) || context.req.path.startsWith('/internal/')) {
      return next();
    }
    const origin = context.req.header('origin');
    if (origin && !config.allowedOrigins.includes(origin)) {
      throw new ApiProblem(403, 'bad_origin', `origin ${origin} is not allowed`);
    }
    return next();
  });

  // Resolve the session for every request; individual routes decide if it is required.
  app.use('*', async (context, next) => {
    const token = getCookie(context, SESSION_COOKIE);
    const userId = verifySessionToken(token, config.SESSION_SECRET);
    if (userId) context.set('userId', userId);
    return next();
  });

  app.onError((error, context) => {
    const { body, status } = toErrorResponse(error, context);
    if (status >= 500) {
      logger().error({ err: error, requestId: body.requestId }, 'unhandled error');
    } else {
      logger().warn({ err: error, requestId: body.requestId, status }, 'request rejected');
    }
    return context.json(body, status as 400);
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
    if (isProtected && !context.get('userId')) throw unauthorized();
    return next();
  });

  registerHealthRoutes(app);
  registerAuthRoutes(app);
  registerPortfolioRoutes(app);
  registerHoldingsRoutes(app);
  registerTargetsRoutes(app);
  registerProposalsRoutes(app);
  registerNotificationsRoutes(app);
  registerSettingsRoutes(app);
  registerTelegramRoutes(app);
  registerImportRoutes(app);
  registerInternalRoutes(app);

  return app;
}

/** The authenticated user id, guaranteed present inside the protected router. */
export function currentUserId(context: { get: (key: 'userId') => string | undefined }): string {
  const userId = context.get('userId');
  if (!userId) throw unauthorized();
  return userId;
}
