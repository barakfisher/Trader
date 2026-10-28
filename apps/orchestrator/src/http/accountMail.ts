/**
 * The mails about an account (D258, D259, D303, D344): a verification link,
 * "someone tried to sign up with your address", a new address's link and the
 * notice to the old one, and "your account was approved". Each is written in the account's language and links back to the
 * origin the request came from (`pageLink`).
 *
 * Sign-up sends in the background (`sendInBackground`): the answer must not
 * wait on SMTP, or its timing would tell a new address from an existing one
 * (D185). A failure is logged by user id - never by address - and the person
 * can ask for a new link from sign-in (D306).
 */

import { UI_LANGUAGES, type UiLanguage } from '@traders/shared';

import { getOrCreateUserSettings, issueAuthToken } from '../db/queries.js';
import { emailMessages } from '../email/messages.js';
import type { EmailSender } from '../email/sender.js';
import { logger } from '../logger.js';
import {
  RESET_TOKEN_TTL_MINUTES,
  SIGNUP_LINK_HINT,
  VERIFY_TOKEN_TTL_HOURS,
  linkTokenHash,
  newLinkToken,
  pageLink,
} from './linkTokens.js';

/** Where the person reads a link: the sign-up's language, else English. */
export function mailLanguage(language: string | null | undefined): UiLanguage {
  return (UI_LANGUAGES as readonly string[]).includes(language ?? '') ? (language as UiLanguage) : 'en';
}

/** The page a verification link opens; it posts the token to `POST /auth/verify`. */
export const VERIFY_PAGE = '/verify';

/** The page a reset link opens; it posts the token and the new password to `POST /auth/reset`. */
export const RESET_PAGE = '/reset';

export interface Recipient {
  userId: string;
  email: string;
  language: UiLanguage;
}

/**
 * A new single-use link for `purpose`, cancelling the account's earlier one
 * (D260), sent to `recipient.email`: a sign-up's address or a pending new one.
 */
export async function sendVerificationLink(
  sender: EmailSender,
  origin: string,
  recipient: Recipient,
  purpose: 'verify_email' | 'verify_new_email',
): Promise<void> {
  const token = newLinkToken();
  await issueAuthToken({
    userId: recipient.userId,
    purpose,
    email: recipient.email,
    tokenHash: linkTokenHash(token),
    ttlMinutes: VERIFY_TOKEN_TTL_HOURS * 60,
  });
  const link = pageLink(origin, VERIFY_PAGE, token, purpose === 'verify_email' ? SIGNUP_LINK_HINT : {});
  const compose = purpose === 'verify_email' ? emailMessages.verifyEmail : emailMessages.verifyNewEmail;
  await sender.send(compose(recipient.email, recipient.language, link, VERIFY_TOKEN_TTL_HOURS));
}

/** A new reset link (D260, D312), cancelling the account's earlier one; it works for half an hour. */
export async function sendResetLink(sender: EmailSender, origin: string, recipient: Recipient): Promise<void> {
  const token = newLinkToken();
  await issueAuthToken({
    userId: recipient.userId,
    purpose: 'reset_password',
    email: recipient.email,
    tokenHash: linkTokenHash(token),
    ttlMinutes: RESET_TOKEN_TTL_MINUTES,
  });
  const link = pageLink(origin, RESET_PAGE, token);
  await sender.send(emailMessages.resetPassword(recipient.email, recipient.language, link, RESET_TOKEN_TTL_MINUTES));
}

/** After any password change, by reset or from Settings (D312): a change the owner did not make is seen. */
export async function sendPasswordChanged(sender: EmailSender, origin: string, recipient: Omit<Recipient, 'userId'>): Promise<void> {
  await sender.send(emailMessages.passwordChanged(recipient.email, recipient.language, pageLink(origin, '/')));
}

/** Sign-up with an address that already has an account or a decided request (D303). */
export async function sendSignupExists(sender: EmailSender, origin: string, recipient: Recipient): Promise<void> {
  await sender.send(emailMessages.signupExists(recipient.email, recipient.language, pageLink(origin, '/')));
}

/** To the current address, when a change to `newEmail` is asked for (D259). */
export async function sendEmailChangeNotice(sender: EmailSender, recipient: Recipient, newEmail: string): Promise<void> {
  await sender.send(emailMessages.emailChangeRequested(recipient.email, recipient.language, newEmail));
}

/**
 * The deletion date as the person reads it: a long date and time in their
 * language and their own zone (D163), so "deleted on" is their calendar's day.
 */
export function deletionDate(dueAt: Date, language: UiLanguage, timeZone: string): string {
  return new Intl.DateTimeFormat(language, { dateStyle: 'long', timeStyle: 'short', timeZone }).format(dueAt);
}

/** The account was closed at the user's request (D264): when it will be erased, and that signing in cancels it. */
export async function sendAccountClosed(
  sender: EmailSender,
  origin: string,
  recipient: Omit<Recipient, 'userId'>,
  dueAt: Date,
  timeZone: string,
): Promise<void> {
  const date = deletionDate(dueAt, recipient.language, timeZone);
  await sender.send(emailMessages.accountClosed(recipient.email, recipient.language, date, pageLink(origin, '/')));
}

/**
 * A sign-in reopened a closed account (D264): mailed in the background, so a
 * sign-in by someone who knows the password - or a provider they linked -
 * cannot quietly undo a deletion the owner believes has happened. Not awaited
 * by the sign-in, and never fails it.
 */
export function announceAccountRestored(sender: EmailSender | null, user: { id: string; email: string | null }): void {
  if (sender === null || user.email === null) return;
  const to = user.email;
  // The settings read is in the background too: the sign-in has already succeeded.
  sendInBackground(user.id, 'account_restored', async () => {
    const language = mailLanguage((await getOrCreateUserSettings(user.id)).language);
    await sender.send(emailMessages.accountRestored(to, language));
  });
}

/**
 * A waiting sign-up was approved (D344), from the Admin page or Telegram: until
 * then the person learned it only by trying to sign in. Called once, when the
 * approval's own UPDATE applied - a second tap or a stale page sends nothing -
 * and in the background, so a mail failure neither undoes nor fails it.
 *
 * The link is the installation's first `ALLOWED_ORIGINS` entry, not the
 * admin's origin: the admin may be on localhost or the phone's Tailscale name,
 * which the person cannot reach, and in production D310 leaves the public host
 * the only entry. A rejection is never mailed (D344).
 */
export function announceSignupApproved(
  sender: EmailSender | null,
  allowedOrigins: readonly string[],
  user: { id: string; email: string | null },
): void {
  const origin = allowedOrigins[0];
  if (sender === null || user.email === null || origin === undefined) return;
  const to = user.email;
  sendInBackground(user.id, 'signup_approved', async () => {
    const language = mailLanguage((await getOrCreateUserSettings(user.id)).language);
    await sender.send(emailMessages.signupApproved(to, language, pageLink(origin, '/')));
  });
}

/**
 * What of a mail failure may be logged: the SMTP code and command, never the
 * error itself - `nodemailer`'s errors carry the refused recipients and the
 * server's reply, both of which name the address.
 */
export function mailFailure(error: unknown): { code?: unknown; responseCode?: unknown; command?: unknown } {
  if (typeof error !== 'object' || error === null) return {};
  const { code, responseCode, command } = error as Record<string, unknown>;
  return { code, responseCode, command };
}

/** Run a mail without waiting for it; a failure is logged with the user and what failed, never the address. */
export function sendInBackground(userId: string, what: string, send: () => Promise<void>): void {
  void send().catch((error: unknown) => {
    logger().error({ failure: mailFailure(error), userId, mail: what }, 'mail not sent');
  });
}
