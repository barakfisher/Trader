/**
 * Sign-up, sign-in, sign-out, "who am I" and changing one's own password or
 * email (D156, D159, D160, D185).
 *
 * Email and password, the password hashed with argon2id. A session is the
 * signed cookie of `http/auth.ts`, carrying the user's `session_version`, so a
 * password or email change - which bumps it - ends every other session the user holds
 * and reissues this one.
 */

import type { Context, Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';

import {
  emailProblem,
  normaliseEmail,
  timeZoneProblem,
  UI_LANGUAGES,
  type SessionUser,
  type SignupResponse,
  type UiLanguage,
} from '@traders/shared';

import {
  changeEmail,
  changePassword,
  changeTimeZone,
  createSignupRequest,
  getOrCreateUserSettings,
  getPasswordHash,
  getUser,
  getUserCredentialsByEmail,
  recordSignIn,
  type UserRow,
} from '../../db/queries.js';
import { announceSignupRequest } from '../../telegram/signupApproval.js';
import type { AppEnv } from '../app.js';
import { SESSION_COOKIE, createSessionToken } from '../auth.js';
import { ApiProblem, badRequest, conflict, unauthorized } from '../errors.js';
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

const signupSchema = z.object({
  email: z.string().max(1000),
  password: submittedPassword,
  timezone: z.string().max(200),
  language: z.enum(UI_LANGUAGES),
});

const passwordChangeSchema = z.object({
  currentPassword: submittedPassword,
  newPassword: submittedPassword,
});

const timeZoneChangeSchema = z.object({ timezone: z.string().max(200) });

const emailChangeSchema = z.object({
  email: z.string().max(1000),
  currentPassword: submittedPassword,
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
    email: user.email,
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
    if (credentials.status === 'pending') {
      throw new ApiProblem(403, 'account_pending', 'this account is waiting for the admin\'s approval');
    }
    if (credentials.status !== 'active') {
      throw new ApiProblem(403, 'account_not_active', `this account is ${credentials.status}`);
    }
    const user = await getUser(credentials.id);
    if (!user) throw unauthorized('incorrect email or password');

    await recordSignIn(user.id);
    issueSession(context, user);
    return context.json(await sessionUser(user));
  });

  /**
   * Ask to join (D156). The one route that writes while signed out, so it says
   * as little as it can (D185): `received` for a new email, one already
   * waiting, one rejected and an existing account alike - only a new email
   * messages the admin - and `closed` while the limit on waiting requests is
   * reached, which says nothing about any account. The password is hashed
   * whatever the email, so the time taken does not tell them apart either.
   * A malformed address, password or zone is refused, as the form refuses it.
   */
  app.post('/auth/signup', async (context) => {
    const parsed = signupSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      throw badRequest('invalid_body', 'expected { email, password, timezone, language }');
    }
    const email = normaliseEmail(parsed.data.email);
    const emailIssue = emailProblem(email);
    if (emailIssue !== null) throw badRequest(`email_${emailIssue}`, `the address is ${emailIssue.replace('_', ' ')}`);
    const passwordIssue = passwordProblem(parsed.data.password);
    if (passwordIssue !== null) {
      throw badRequest(`password_${passwordIssue}`, `the password is ${passwordIssue.replace('_', ' ')}`);
    }
    if (timeZoneProblem(parsed.data.timezone) !== null) {
      throw badRequest('timezone_invalid', 'the time zone is not an IANA zone name');
    }

    const created = await createSignupRequest({
      email,
      passwordHash: await hashPassword(parsed.data.password),
      timezone: parsed.data.timezone,
      language: parsed.data.language,
    });
    if (created.outcome === 'created') {
      // Not awaited: a Telegram round trip only for new emails would itself tell
      // them apart, and the request waits on the Admin page whatever it does.
      void announceSignupRequest(
        { notifier: context.get('notifier'), signingSecret: context.get('config').TELEGRAM_SIGNING_SECRET },
        created.userId,
      );
    }
    const body: SignupResponse = { outcome: created.outcome === 'closed' ? 'closed' : 'received' };
    return context.json(body);
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

  /**
   * Change one's own sign-in address. The current password is asked for, as
   * for a password change: a session left open is not the account. Nothing is
   * sent to the new address - there is no outbound email before M10 (decided
   * 2026-10-19) - so a typo is corrected the same way, while still signed in.
   */
  app.post('/auth/email', async (context) => {
    const user = context.get('user');
    if (!user) throw unauthorized();
    // `/auth/*` is outside the session gate's refusal so the one-time password can be changed (D162); nothing else can.
    if (user.password_must_change) throw new ApiProblem(403, 'password_change_required', 'set a new password first');
    const parsed = emailChangeSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) throw badRequest('invalid_body', 'expected { email: string, currentPassword: string }');
    const email = normaliseEmail(parsed.data.email);

    if (!(await passwordMatches(parsed.data.currentPassword, await getPasswordHash(user.id)))) {
      throw new ApiProblem(403, 'incorrect_password', 'the current password is incorrect');
    }
    const problem = emailProblem(email);
    if (problem !== null) throw badRequest(`email_${problem}`, `the address is ${problem.replace('_', ' ')}`);
    if (email === user.email?.toLowerCase()) throw badRequest('email_unchanged', 'the address is the current one');

    const updated = await changeEmail(user.id, email);
    // Said only to someone who knows this account's password.
    if (updated === 'taken') throw conflict('email_taken', 'another account uses this address');
    if (!updated) throw unauthorized();
    issueSession(context, updated);
    return context.json(await sessionUser(updated));
  });

  /**
   * The user's own zone (D163), edited in Settings: a valid IANA name only. It
   * moves "today" - quiet hours, the digest, the snapshot's day - from the next
   * run on; a run already done today is not repeated or undone, so a mid-day
   * change may run or skip one daily run once (accepted in D163).
   */
  app.post('/auth/timezone', async (context) => {
    const user = context.get('user');
    if (!user) throw unauthorized();
    // `/auth/*` is outside the session gate's refusal so the one-time password can be changed (D162); nothing else can.
    if (user.password_must_change) throw new ApiProblem(403, 'password_change_required', 'set a new password first');
    const parsed = timeZoneChangeSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) throw badRequest('invalid_body', 'expected { timezone: string }');
    if (timeZoneProblem(parsed.data.timezone) !== null) {
      throw badRequest('timezone_invalid', 'the zone is not an IANA time zone such as Europe/London');
    }
    const updated = await changeTimeZone(user.id, parsed.data.timezone);
    if (!updated) throw unauthorized();
    return context.json(await sessionUser(updated));
  });
}
