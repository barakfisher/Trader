/**
 * Login, logout and "who am I". Single-user v1: the passphrase from config is
 * the only credential, and a successful login issues a session for the seeded
 * user id.
 */

import type { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';

import { getUser } from '../../db/queries.js';
import type { AppEnv } from '../app.js';
import { SESSION_COOKIE, createSessionToken, passphraseMatches } from '../auth.js';
import { badRequest, notFound, unauthorized } from '../errors.js';

const loginSchema = z.object({ passphrase: z.string().min(1) });

export function registerAuthRoutes(app: Hono<AppEnv>): void {
  app.post('/auth/login', async (context) => {
    const config = context.get('config');
    const parsed = loginSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) throw badRequest('invalid_body', 'expected { passphrase: string }');

    if (!passphraseMatches(parsed.data.passphrase, config.APP_PASSPHRASE)) {
      // Deliberately vague: do not confirm whether a passphrase was close.
      throw unauthorized('incorrect passphrase');
    }

    const user = await getUser(config.SINGLE_USER_ID);
    if (!user) throw notFound('the seeded user is missing; run database migrations');

    setCookie(context, SESSION_COOKIE, createSessionToken(user.id, config.SESSION_SECRET, config.SESSION_TTL_HOURS), {
      httpOnly: true,
      sameSite: 'Lax',
      secure: config.isProduction,
      path: '/',
      maxAge: config.SESSION_TTL_HOURS * 3600,
    });

    return context.json({
      id: user.id,
      baseCurrency: user.base_currency,
      timezone: user.timezone,
    });
  });

  app.post('/auth/logout', (context) => {
    deleteCookie(context, SESSION_COOKIE, { path: '/' });
    return context.json({ ok: true });
  });

  app.get('/auth/session', async (context) => {
    const userId = context.get('userId');
    if (!userId) return context.json({ authenticated: false }, 200);
    const user = await getUser(userId);
    if (!user) return context.json({ authenticated: false }, 200);
    return context.json({
      authenticated: true,
      user: { id: user.id, baseCurrency: user.base_currency, timezone: user.timezone },
    });
  });
}
