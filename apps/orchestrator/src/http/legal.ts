/**
 * The privacy policy and terms on the server (D265): who must accept the
 * current version, and the gate that keeps public sign-up closed while the
 * text is pending.
 */

import type { Context } from 'hono';

import type { UserRow } from '../db/queries.js';
import type { AppEnv } from './app.js';

/**
 * What a user who has not accepted the current legal version may still do:
 * export their data and delete the account - someone who declines new terms
 * must lose neither. `/auth/*` (signing out, accepting) is outside the
 * session gate already.
 */
export const LEGAL_GATE_EXEMPT_PATHS: ReadonlySet<string> = new Set(['/account/export', '/account/deletion']);

/**
 * The user must accept the current legal version before anything else.
 * `legalAccepted` is the session middleware's reading, true when there is no
 * version yet. The admin runs the installation whose terms these are, so is
 * never asked.
 */
export function legalAcceptanceRequired(user: UserRow, legalAccepted: boolean | undefined): boolean {
  return user.role !== 'admin' && legalAccepted === false;
}

/**
 * A production installation whose text is still the placeholder (D265, the
 * user's choice of scope): sign-up is closed whatever the mode, and the mode
 * cannot be opened. Development installations - compose and kind, which no
 * stranger reaches (D256) - are not held.
 */
export function signupHeldForLegalText(context: Context<AppEnv>): boolean {
  return context.get('config').isProduction && context.get('legalVersion') === null;
}
