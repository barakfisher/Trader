/**
 * Whether a user's own work may run now: a closed (D264) or disabled (D239)
 * account runs nothing, nor one that has not accepted the current privacy
 * policy and terms (D320) - nothing is done with its data, nor its budget
 * spent, until it does. The admin is never held for the terms. Asked by the
 * scheduled scans and research when an attempt comes off the queue, and by
 * the per-user runs of `POST /internal/runs`.
 */

import { LEGAL_VERSION } from '@traders/shared';

import { getUser, hasAcceptedLegalVersion } from '../db/queries.js';

/**
 * Why a run was skipped: its account was closed (D264) or disabled
 * (D239) after the slot was queued, so it runs nothing more (D316's debt).
 */
export const USER_NOT_ACTIVE = 'user_not_active';

/**
 * Why a run was skipped: the account has not accepted the current
 * privacy policy and terms (D320), so nothing is done with its data - nor its
 * budget spent - until it does.
 */
export const LEGAL_NOT_ACCEPTED = 'legal_not_accepted';

/**
 * Why work for `userId` must not run, or null when it may: the
 * account's status, then its acceptance of `legalVersion` - which the admin,
 * whose installation's terms these are, is never asked for.
 */
export async function accountHold(userId: string, legalVersion: string | null = LEGAL_VERSION): Promise<string | null> {
  const user = await getUser(userId);
  if (user?.status !== 'active') return USER_NOT_ACTIVE;
  if (legalVersion !== null && user.role !== 'admin' && !(await hasAcceptedLegalVersion(userId, legalVersion))) {
    return LEGAL_NOT_ACCEPTED;
  }
  return null;
}
