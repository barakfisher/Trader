/**
 * Deleting one's own account, and taking one's data out first (D264).
 *
 * A deletion closes the account at once - every session ends, nothing is
 * scheduled for it - and the installation's `account_erase` run erases it
 * `ACCOUNT_DELETION_GRACE_DAYS` later. Signing in before then cancels it
 * (`routes/auth.ts`, `routes/oauth.ts`). It is confirmed by the typed word and
 * the password, or - for an account that only signs in through Google or
 * GitHub, which has none - by a sign-in moments ago: a session left open on a
 * shared computer is not the account's owner.
 */

import type { Hono } from 'hono';
import { deleteCookie } from 'hono/cookie';
import { z } from 'zod';

import {
  ACCOUNT_DELETION_CONFIRMATION,
  ACCOUNT_DELETION_GRACE_DAYS,
  type AccountDeletionCheck,
  type AccountDeletionInput,
  type AccountDeletionResponse,
} from '@traders/shared';

import {
  closeAccount,
  exportAccount,
  getOrCreateUserSettings,
  getPasswordHash,
  sessionSignedInWithin,
} from '../../db/queries.js';
import { mailLanguage, sendAccountClosed, sendInBackground } from '../accountMail.js';
import type { AppEnv } from '../app.js';
import { SESSION_COOKIE } from '../auth.js';
import { ApiProblem, badRequest, conflict, forbidden, unauthorized, unprocessable } from '../errors.js';
import { limitPerUser } from '../rateLimits.js';
import { currentPasswordMatches, submittedPassword } from './auth.js';

/** How recent a sign-in confirms the deletion of an account with no password (D264). */
export const RECENT_SIGN_IN_MINUTES = 10;

const deletionSchema = z
  .object({ confirm: z.string().max(40), password: submittedPassword.optional() })
  .strict() satisfies z.ZodType<AccountDeletionInput>;

export function registerAccountDeletionRoutes(app: Hono<AppEnv>): void {
  /** What the Settings card asks for before it offers the button. */
  app.get('/account/deletion', async (context) => {
    const user = context.get('user');
    const sessionId = context.get('sessionId');
    if (!user || !sessionId) throw unauthorized();
    const hasPassword = (await getPasswordHash(user.id)) !== null;
    const body: AccountDeletionCheck = {
      confirmWith: hasPassword ? 'password' : 'recent_sign_in',
      recentSignIn: await sessionSignedInWithin(user.id, sessionId, RECENT_SIGN_IN_MINUTES),
      recentSignInMinutes: RECENT_SIGN_IN_MINUTES,
      allowed: user.role !== 'admin',
      graceDays: ACCOUNT_DELETION_GRACE_DAYS,
    };
    return context.json(body);
  });

  app.post('/account/deletion', async (context) => {
    const user = context.get('user');
    const sessionId = context.get('sessionId');
    if (!user || !sessionId) throw unauthorized();
    const parsed = deletionSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) throw badRequest('invalid_body', 'expected { confirm: string, password?: string }');
    if (parsed.data.confirm !== ACCOUNT_DELETION_CONFIRMATION) {
      throw unprocessable('deletion_not_confirmed', `type ${ACCOUNT_DELETION_CONFIRMATION} to confirm`);
    }
    // The installation's admin runs it; leaving is not a Settings button for them.
    if (user.role === 'admin') throw forbidden('the admin cannot delete their account');

    if ((await getPasswordHash(user.id)) !== null) {
      const password = parsed.data.password;
      if (password === undefined) throw badRequest('password_required', 'confirm with your password');
      // Counted against the account as a sign-in is (D257, D310).
      if (!(await currentPasswordMatches(context, user, password))) {
        throw new ApiProblem(403, 'incorrect_password', 'the current password is incorrect');
      }
    } else if (!(await sessionSignedInWithin(user.id, sessionId, RECENT_SIGN_IN_MINUTES))) {
      throw new ApiProblem(403, 'sign_in_again', `sign in again; a sign-in counts for ${RECENT_SIGN_IN_MINUTES} minutes`);
    }

    const closed = await closeAccount(user.id, ACCOUNT_DELETION_GRACE_DAYS);
    if (!closed) throw conflict('not_active', 'this account cannot be closed');

    const sender = context.get('email');
    if (sender !== null && closed.email !== null) {
      const language = mailLanguage((await getOrCreateUserSettings(user.id)).language);
      const recipient = { email: closed.email, language };
      // Present on every write: the Origin gate refused this request otherwise.
      const origin = context.req.header('origin')!;
      sendInBackground(user.id, 'account_closed', () =>
        sendAccountClosed(sender, origin, recipient, closed.deletion_due_at, closed.timezone),
      );
    }
    // Every session ended with the close, this one too.
    deleteCookie(context, SESSION_COOKIE, { path: '/' });
    const body: AccountDeletionResponse = { deletionDueAt: closed.deletion_due_at.toISOString() };
    return context.json(body);
  });

  /**
   * The user's own rows as one JSON file (D264). Built by Postgres and sent as
   * it came, so no quantity passes through a float; never cached, since it is
   * the whole account.
   */
  app.get('/account/export', limitPerUser('dataExportPerUser'), async (context) => {
    const user = context.get('user');
    if (!user) throw unauthorized();
    const document = await exportAccount(user.id);
    const day = new Date().toISOString().slice(0, 10);
    return context.body(document, 200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="traders-export-${day}.json"`,
      'cache-control': 'no-store',
    });
  });
}
