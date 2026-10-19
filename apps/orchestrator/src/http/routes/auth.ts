/**
 * Sign-in, sign-out, "who am I" and changing one's own password (D159, D160).
 *
 * Email and password, the password hashed with argon2id. A session is the
 * signed cookie of `http/auth.ts`, carrying the user's `session_version`, so a
 * password change - which bumps it - ends every other session the user holds
 * and reissues this one.
 */

import type { Context, Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';

import type { SessionUser, UiLanguage } from '@traders/shared';

import {
  changePassword,
  getOrCreateUserSettings,
  getPasswordHash,
  getUser,
  getUserCredentialsByEmail,
  recordSignIn,
  type UserRow,
} from '../../db/queries.js';
import type { AppEnv } from '../app.js';
import { SESSION_COOKIE, createSessionToken } from '../auth.js';
import { ApiProblem, badRequest, unauthorized } from '../errors.js';
import { PASSWORD_MAX_LENGTH, hashPassword, passwordMatches, passwordProblem } from '../password.js';

/**
 * The submitted password is bounded before it reaches argon2, generously
 * above the rule's ceiling so an over-long one still gets the rule's message
 * rather than a shape error.
 */
const submittedPassword = z.string().min(1).max(PASSWORD_MAX_LENGTH * 4);

const loginSchema = z.object({
  email: z.string().trim().min(1).max(320),
  password: submittedPassword,
});

const passwordChangeSchema = z.object({
  currentPassword: submittedPassword,
  newPassword: submittedPassword,
});

/**
 * The signed-in user as the web app needs it before drawing anything: who,
 * which currency and timezone - and which language, read from the settings row
 * (materialised with the schema's defaults if the user never saved one), so
 * the first screen is already in it.
 */
async function sessionUser(user: UserRow): Promise<SessionUser> {
  const settings = await getOrCreateUserSettings(user.id);
  return {
    id: user.id,
    baseCurrency: user.base_currency,
    timezone: user.timezone,
    role: user.role,
    language: settings.language as UiLanguage,
    mustChangePassword: user.password_must_change,
  };
}

function issueSession(context: Context<AppEnv>, user: UserRow): void {
  const config = context.get('config');
  const token = createSessionToken(
    { userId: user.id, sessionVersion: user.session_version },
    config.SESSION_SECRET,
    config.SESSION_TTL_HOURS,
  );
  setCookie(context, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: config.isProduction,
    path: '/',
    maxAge: config.SESSION_TTL_HOURS * 3600,
  });
}

export function registerAuthRoutes(app: Hono<AppEnv>): void {
  app.post('/auth/login', async (context) => {
    const parsed = loginSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) throw badRequest('invalid_body', 'expected { email: string, password: string }');

    const credentials = await getUserCredentialsByEmail(parsed.data.email);
    // The same argon2 work whether or not the email exists (`passwordMatches`),
    // and the same answer: neither says which accounts there are.
    const matches = await passwordMatches(parsed.data.password, credentials?.password_hash ?? null);
    if (!credentials || !matches) throw unauthorized('incorrect email or password');

    // Only someone who knows the password learns the account's state.
    if (credentials.status !== 'active') {
      throw new ApiProblem(403, 'account_not_active', `this account is ${credentials.status}`);
    }
    const user = await getUser(credentials.id);
    if (!user) throw unauthorized('incorrect email or password');

    await recordSignIn(user.id);
    issueSession(context, user);
    return context.json(await sessionUser(user));
  });

  app.post('/auth/logout', (context) => {
    deleteCookie(context, SESSION_COOKIE, { path: '/' });
    return context.json({ ok: true });
  });

  app.get('/auth/session', async (context) => {
    // Already read and checked against the cookie by the session middleware.
    const user = context.get('user');
    if (!user) return context.json({ authenticated: false }, 200);
    return context.json({ authenticated: true, user: await sessionUser(user) });
  });

  /**
   * Change one's own password - the only thing an account with the admin's
   * one-time password can do (D162), which is why `/auth/*` is outside the
   * session gate's must-change refusal. The current password is asked for even
   * then: a session left open is not the password.
   */
  app.post('/auth/password', async (context) => {
    const user = context.get('user');
    if (!user) throw unauthorized();
    const parsed = passwordChangeSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      throw badRequest('invalid_body', 'expected { currentPassword: string, newPassword: string }');
    }
    const { currentPassword, newPassword } = parsed.data;

    if (!(await passwordMatches(currentPassword, await getPasswordHash(user.id)))) {
      throw new ApiProblem(403, 'incorrect_password', 'the current password is incorrect');
    }
    const problem = passwordProblem(newPassword);
    if (problem !== null) throw badRequest(`password_${problem}`, `the new password is ${problem.replace('_', ' ')}`);
    if (newPassword === currentPassword) {
      throw badRequest('password_unchanged', 'the new password is the current one');
    }

    const updated = await changePassword(user.id, await hashPassword(newPassword));
    if (!updated) throw unauthorized();
    // The bump ended this session too; the new cookie carries the new version.
    issueSession(context, updated);
    return context.json(await sessionUser(updated));
  });
}
