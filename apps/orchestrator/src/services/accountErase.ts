/**
 * The installation's `account_erase` run (D264): every account whose deletion
 * date has come, and - while signup is *automatic* - every request rejected
 * more than `REJECTED_SIGNUP_RETENTION_DAYS` ago. In *approval* mode a rejected
 * request is the admin's record that this address was turned down (D156), so
 * it is kept, as before.
 *
 * One account at a time, each in its own transaction (`erase_account`): a
 * failure leaves that account for the next run and does not stop the others.
 */

import {
  eraseAccount,
  getInstallationSettings,
  listAccountsDueForErase,
  listRejectedSignupsOlderThan,
} from '../db/queries.js';
import { logger } from '../logger.js';

/** How long *automatic* signup keeps a rejected request (D264). */
export const REJECTED_SIGNUP_RETENTION_DAYS = 90;

export interface EraseResult {
  accounts: number;
  rejectedSignups: number;
  /** Erases that threw; their accounts stay for the next run. */
  failed: number;
}

export async function eraseDueAccounts(): Promise<EraseResult> {
  const settings = await getInstallationSettings();
  const due = await listAccountsDueForErase();
  const rejected =
    settings.signup_mode === 'automatic' ? await listRejectedSignupsOlderThan(REJECTED_SIGNUP_RETENTION_DAYS) : [];
  const result: EraseResult = { accounts: 0, rejectedSignups: 0, failed: 0 };
  for (const [ids, counted] of [
    [due, 'accounts'],
    [rejected, 'rejectedSignups'],
  ] as const) {
    for (const userId of ids) {
      try {
        // False: reopened by a sign-in since it was listed - nothing to count.
        if (await eraseAccount(userId)) result[counted] += 1;
      } catch (error) {
        result.failed += 1;
        logger().error({ err: error, userId }, 'account_erase.failed');
      }
    }
  }
  return result;
}
