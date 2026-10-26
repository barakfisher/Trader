/**
 * Sign-up, sign-in, sign-out, "who am I" and changing one's own password or
 * email (D156, D159, D160, D185, D261).
 *
 * Signing up proves the address with a link before anyone sees the request
 * (D259), and a changed address waits for its own link. Email and password,
 * the password hashed with argon2id. A session is a row of
 * `user_sessions` named by the signed cookie of `http/auth.ts`, so signing out
 * deletes this device's row, and a password change or a confirmed new address
 * - which delete every row the user has - end every other session; this device
 * gets a new one where it is the device that made the change.
 */

import type { Context, Hono } from 'hono';
import { deleteCookie } from 'hono/cookie';
import { z } from 'zod';

import {
  emailProblem,
  normaliseEmail,
  timeZoneProblem,
  UI_LANGUAGES,
  type SessionUser,
  type SignupResponse,
  type UiLanguage,
  type VerifyEmailResponse,
} from '@traders/shared';

import {
  changePassword,
  changeTimeZone,
  createSignupRequest,
  deleteSession,
  emailInUse,
  getInstallationSettings,
  getOrCreateUserSettings,
  getPasswordHash,
  getUser,
  getUserCredentialsByEmail,
  recordSignIn,
  setPendingEmail,
  peekVerificationToken,
  useVerificationToken,
  type UserRow,
} from '../../db/queries.js';
import {
  mailLanguage,
  sendEmailChangeNotice,
  sendInBackground,
  sendSignupExists,
  sendVerificationLink,
} from '../accountMail.js';
import { linkTokenHash } from '../linkTokens.js';
import { announceSignupRequest } from '../../telegram/signupApproval.js';
import type { AppEnv } from '../app.js';
import { SESSION_COOKIE } from '../auth.js';
import { issueSession } from '../sessions.js';
import { ApiProblem, badRequest, conflict, unauthorized } from '../errors.js';
import { emailKey, requestAddressKey, userKey } from '../rateLimits.js';
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

/** A sign-up's link carries its password (D309); an address change's does not need one. */
const verifySchema = z.object({ token: z.string().min(1).max(200), password: submittedPassword.optional() });

/** The sign-in refusal for a request whose address was never proven (D306); the web offers a new link. */
export const EMAIL_UNVERIFIED = 'email_unverified';

/**
 * The page's origin: present on every write - the Origin gate refuses one
 * without it - and one of `ALLOWED_ORIGINS`, so a link built on it points back
 * to an address this installation serves.
 */
function requestOrigin(context: Context<AppEnv>): string {
  return context.req.header('origin')!;
}

/**
 * The current password asked for in Settings, counted as a sign-in is (D257,
 * D310): a session left open, or stolen, must not be a way to guess the
 * password without a limit. The account's failures are keyed by its address.
 */
async function currentPasswordMatches(context: Context<AppEnv>, user: UserRow, password: string): Promise<boolean> {
  const limits = context.get('rateLimits');
  const account = user.email ? emailKey(normaliseEmail(user.email)) : userKey(user.id);
  await limits.refuseIfSpent('loginFailuresPerAccount', account);
  if (await passwordMatches(password, await getPasswordHash(user.id))) return true;
  await limits.record('loginFailuresPerAccount', account);
  return false;
}

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
    pendingEmail: user.pending_email,
  };
}

export function registerAuthRoutes(app: Hono<AppEnv>): void {
  app.post('/auth/login', async (context) => {
    const parsed = loginSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) throw badRequest('invalid_body', 'expected { email: string, password: string }');

    // D257: failed attempts are counted per account and per address, and a
    // spent count is refused before the hash is computed. The account is the
    // email as typed, existing or not, so a refusal says nothing about which
    // accounts there are.
    const limits = context.get('rateLimits');
    const account = emailKey(normaliseEmail(parsed.data.email));
    const address = requestAddressKey(context, context.get('config').TRUSTED_PROXY_HOPS);
    await limits.refuseIfSpent('loginFailuresPerAccount', account);
    await limits.refuseIfSpent('loginFailuresPerAddress', address);

    const credentials = await getUserCredentialsByEmail(parsed.data.email);
    // The same argon2 work whether or not the email exists (`passwordMatches`),
    // and the same answer: neither says which accounts there are.
    const matches = await passwordMatches(parsed.data.password, credentials?.password_hash ?? null);
    if (!credentials || !matches) {
      await limits.record('loginFailuresPerAccount', account);
      await limits.record('loginFailuresPerAddress', address);
      throw unauthorized('incorrect email or password');
    }
    // The right password ends the account's run of failures; the address's
    // count stays, so one known password does not reopen guessing at others.
    await limits.reset('loginFailuresPerAccount', account);

    // Only someone who knows the password learns the account's state: a
    // request whose address was never proven is waiting for its link (D306),
    // a verified one for the admin.
    if (credentials.status === 'pending' && !credentials.email_verified) {
      throw new ApiProblem(403, EMAIL_UNVERIFIED, 'confirm your email address first');
    }
    if (credentials.status === 'pending') {
      throw new ApiProblem(403, 'account_pending', 'this account is waiting for the admin\'s approval');
    }
    if (credentials.status !== 'active') {
      throw new ApiProblem(403, 'account_not_active', `this account is ${credentials.status}`);
    }
    const user = await getUser(credentials.id);
    // A password change, a one-time password or a disable that committed while
    // argon2 ran moved the version: the password just checked is no longer the
    // account's, so it opens no session (D297). Said as a wrong password, which
    // it now is.
    if (!user || user.session_version !== credentials.session_version) {
      throw unauthorized('incorrect email or password');
    }

    // Signing in again on this browser ends the session it already had, so the
    // old cookie - and any copy of it - does not outlive the new one.
    const previousUser = context.get('userId');
    const previousSession = context.get('sessionId');
    if (previousUser && previousSession) await deleteSession(previousUser, previousSession);

    await recordSignIn(user.id);
    await issueSession(context, user);
    return context.json(await sessionUser(user));
  });

  /**
   * Ask to join (D156, D243). The one route that writes while signed out, so it
   * says as little as it can (D185): `received` for a new email, one already
   * waiting, one rejected and an existing account alike, and `closed` while
   * sign-up is closed, which says nothing about any account. A mail reaches
   * the address in every `received` case (D303): a new request's link, a new
   * link for a request still waiting for one, or "someone tried to sign up" -
   * sent in the background, so SMTP's time does not tell them apart, as the
   * password is hashed whatever the email for the same reason. The admin hears
   * of a request only once its address is verified (D259).
   */
  app.post('/auth/signup', async (context) => {
    const parsed = signupSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      throw badRequest('invalid_body', 'expected { email, password, timezone, language }');
    }
    const email = normaliseEmail(parsed.data.email);
    // D257: every request counts, per address and per email, before any work -
    // each mails the address and costs a hash.
    const limits = context.get('rateLimits');
    await limits.consume('signupPerAddress', requestAddressKey(context, context.get('config').TRUSTED_PROXY_HOPS));
    await limits.consume('signupPerEmail', emailKey(email));
    const emailIssue = emailProblem(email);
    if (emailIssue !== null) throw badRequest(`email_${emailIssue}`, `the address is ${emailIssue.replace('_', ' ')}`);
    const passwordIssue = passwordProblem(parsed.data.password);
    if (passwordIssue !== null) {
      throw badRequest(`password_${passwordIssue}`, `the password is ${passwordIssue.replace('_', ' ')}`);
    }
    if (timeZoneProblem(parsed.data.timezone) !== null) {
      throw badRequest('timezone_invalid', 'the time zone is not an IANA zone name');
    }

    const passwordHash = await hashPassword(parsed.data.password);
    // Without mail no address can be proven, so nobody can get in (D259).
    const sender = context.get('email');
    if (sender === null) {
      const closed: SignupResponse = { outcome: 'closed' };
      return context.json(closed);
    }
    const created = await createSignupRequest({
      email,
      passwordHash,
      timezone: parsed.data.timezone,
      language: parsed.data.language,
    });
    const origin = requestOrigin(context);
    if (created.outcome === 'created') {
      const recipient = { userId: created.userId, email, language: parsed.data.language };
      sendInBackground(created.userId, 'verify_email', () => sendVerificationLink(sender, origin, recipient, 'verify_email'));
    } else if (created.outcome === 'exists') {
      const recipient = { userId: created.userId, email, language: mailLanguage(created.language) };
      if (created.status === 'pending' && !created.verified) {
        // Someone retrying a sign-up whose link they lost: a fresh one, the old one cancelled.
        sendInBackground(created.userId, 'verify_email', () => sendVerificationLink(sender, origin, recipient, 'verify_email'));
      } else {
        sendInBackground(created.userId, 'signup_exists', () => sendSignupExists(sender, origin, recipient));
      }
    }
    const body: SignupResponse = { outcome: created.outcome === 'closed' ? 'closed' : 'received' };
    return context.json(body);
  });

  /**
   * A new verification link, asked from sign-in (D306): the same email and
   * password as a sign-in, counted against the same failures, so only someone
   * who knows the password of an unverified request gets a link - and learns
   * that it is one. Anything else is the sign-in's own answer.
   */
  app.post('/auth/verify/resend', async (context) => {
    const parsed = loginSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) throw badRequest('invalid_body', 'expected { email: string, password: string }');
    const limits = context.get('rateLimits');
    const account = emailKey(normaliseEmail(parsed.data.email));
    const address = requestAddressKey(context, context.get('config').TRUSTED_PROXY_HOPS);
    await limits.refuseIfSpent('loginFailuresPerAccount', account);
    await limits.refuseIfSpent('loginFailuresPerAddress', address);

    const credentials = await getUserCredentialsByEmail(parsed.data.email);
    const matches = await passwordMatches(parsed.data.password, credentials?.password_hash ?? null);
    if (!credentials || !matches) {
      await limits.record('loginFailuresPerAccount', account);
      await limits.record('loginFailuresPerAddress', address);
      throw unauthorized('incorrect email or password');
    }
    await limits.reset('loginFailuresPerAccount', account);
    if (credentials.status !== 'pending' || credentials.email_verified || credentials.email === null) {
      throw new ApiProblem(409, 'not_unverified', 'this account is not waiting for an email link');
    }
    await limits.consume('verificationResendPerAccount', account);
    const sender = context.get('email');
    if (sender === null) throw new ApiProblem(503, 'email_unavailable', 'this installation cannot send mail');
    const settings = await getOrCreateUserSettings(credentials.id);
    await sendVerificationLink(
      sender,
      requestOrigin(context),
      { userId: credentials.id, email: credentials.email, language: mailLanguage(settings.language) },
      'verify_email',
    );
    return context.json({ sent: true });
  });

  /**
   * Open a link from an email (D259, D260). Signed out or in: the link proves
   * the mailbox, and on its own it signs nobody in - a forwarded mail must not
   * become a session. When it confirms a new address while that same account
   * is signed in here, this device gets a new session, as a change did before
   * D259; every other session has ended.
   *
   * Every link needs the account's password too (D309, D310): whoever signs up
   * first with an address chooses the password, and whoever asks to move an
   * account to an address is that account's owner, not the mailbox's - so the
   * mailbox alone would let its owner confirm a stranger's account. A wrong
   * one counts as a failed sign-in for the account and leaves the link unused.
   */
  app.post('/auth/verify', async (context) => {
    const parsed = verifySchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      const invalid: VerifyEmailResponse = { outcome: 'invalid' };
      return context.json(invalid);
    }
    const config = context.get('config');
    const tokenHash = linkTokenHash(parsed.data.token);
    let proof: { passwordHash: string } | null = null;
    const peek = await peekVerificationToken(tokenHash);
    if (peek !== null && peek.purpose !== 'reset_password' && peek.open) {
      const limits = context.get('rateLimits');
      const account = emailKey(normaliseEmail(peek.accountEmail ?? ''));
      const address = requestAddressKey(context, config.TRUSTED_PROXY_HOPS);
      await limits.refuseIfSpent('loginFailuresPerAccount', account);
      await limits.refuseIfSpent('loginFailuresPerAddress', address);
      const password = parsed.data.password;
      if (password === undefined || !(await passwordMatches(password, peek.passwordHash))) {
        if (password !== undefined) {
          await limits.record('loginFailuresPerAccount', account);
          await limits.record('loginFailuresPerAddress', address);
        }
        const refused: VerifyEmailResponse = { outcome: 'wrong_password' };
        return context.json(refused);
      }
      await limits.reset('loginFailuresPerAccount', account);
      proof = { passwordHash: peek.passwordHash! };
    }
    const settings = await getInstallationSettings();
    const result = await useVerificationToken(
      tokenHash,
      { defaultCapMicroUsd: settings.default_llm_cap_micro_usd, timezone: config.APP_TIMEZONE },
      proof,
    );
    if (result.outcome === 'awaiting_approval') {
      // Not awaited, as at sign-up before D259: the request waits on the Admin page whatever Telegram does.
      void announceSignupRequest(
        { notifier: context.get('notifier'), signingSecret: config.TELEGRAM_SIGNING_SECRET },
        result.userId,
      );
    }
    if (result.outcome === 'email_changed' && context.get('userId') === result.userId) {
      const user = await getUser(result.userId);
      if (user && user.status === 'active') await issueSession(context, user);
    }
    const body: VerifyEmailResponse = { outcome: result.outcome };
    return context.json(body);
  });

  /**
   * Sign this device out (D261): its session row is deleted, so the cookie -
   * or any copy of it - names nothing from here on, and the browser's copy is
   * deleted too. Signed out already, it only deletes the browser's copy.
   */
  app.post('/auth/logout', async (context) => {
    const userId = context.get('userId');
    const sessionId = context.get('sessionId');
    if (userId && sessionId) await deleteSession(userId, sessionId);
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

    if (!(await currentPasswordMatches(context, user, currentPassword))) {
      throw new ApiProblem(403, 'incorrect_password', 'the current password is incorrect');
    }
    const problem = passwordProblem(newPassword);
    if (problem !== null) throw badRequest(`password_${problem}`, `the new password is ${problem.replace('_', ' ')}`);
    if (newPassword === currentPassword) {
      throw badRequest('password_unchanged', 'the new password is the current one');
    }

    const updated = await changePassword(user.id, await hashPassword(newPassword));
    if (!updated) throw unauthorized();
    // The change ended every session, this one too; this device gets a new one.
    await issueSession(context, updated);
    return context.json(await sessionUser(updated));
  });

  /**
   * Ask to change one's own sign-in address (D259). The current password is
   * asked for, as for a password change: a session left open is not the
   * account. The new address is stored as pending and gets a link; the
   * current one stays the sign-in address - and keeps receiving reset mail -
   * until the link is opened, and is told a change was asked for. Without it a
   * stolen session could move the account's mail to the thief's mailbox.
   */
  app.post('/auth/email', async (context) => {
    const user = context.get('user');
    if (!user) throw unauthorized();
    // `/auth/*` is outside the session gate's refusal so the one-time password can be changed (D162); nothing else can.
    if (user.password_must_change) throw new ApiProblem(403, 'password_change_required', 'set a new password first');
    const parsed = emailChangeSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) throw badRequest('invalid_body', 'expected { email: string, currentPassword: string }');
    const email = normaliseEmail(parsed.data.email);
    // Counted before anything is checked (D310): "taken" is an answer about
    // other accounts, so each try costs one of a few an hour.
    await context.get('rateLimits').consume('emailChangePerUser', userKey(user.id));

    if (!(await currentPasswordMatches(context, user, parsed.data.currentPassword))) {
      throw new ApiProblem(403, 'incorrect_password', 'the current password is incorrect');
    }
    const problem = emailProblem(email);
    if (problem !== null) throw badRequest(`email_${problem}`, `the address is ${problem.replace('_', ' ')}`);
    if (email === user.email?.toLowerCase()) throw badRequest('email_unchanged', 'the address is the current one');
    // Said only to someone who knows this account's password.
    if (await emailInUse(email, user.id)) throw conflict('email_taken', 'another account uses this address');
    const sender = context.get('email');
    if (sender === null) throw new ApiProblem(503, 'email_unavailable', 'this installation cannot send mail');

    await setPendingEmail(user.id, email);
    const language = mailLanguage((await getOrCreateUserSettings(user.id)).language);
    await sendVerificationLink(sender, requestOrigin(context), { userId: user.id, email, language }, 'verify_new_email');
    if (user.email) {
      const current = { userId: user.id, email: user.email, language };
      sendInBackground(user.id, 'email_change_notice', () => sendEmailChangeNotice(sender, current, email));
    }
    const updated = await getUser(user.id);
    if (!updated) throw unauthorized();
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
