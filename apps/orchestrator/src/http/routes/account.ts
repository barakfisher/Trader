/**
 * The signed-in user's own account (D162): reset is each user's, not the
 * admin's - moved out from behind the admin gate in M9. The admin cannot reset
 * another user's account.
 */

import type { Hono } from 'hono';
import { z } from 'zod';

import {
  ACCOUNT_RESET_CONFIRMATION,
  ACCOUNT_RESET_GROUPS,
  type AccountResetInput,
  type AccountResetResponse,
} from '@traders/shared';

import { resetAccount } from '../../db/queries.js';
import { currentUserId, type AppEnv } from '../app.js';
import { badRequest, unprocessable } from '../errors.js';

const resetSchema = z
  .object({
    groups: z.array(z.enum(ACCOUNT_RESET_GROUPS)).min(1),
    confirm: z.string(),
  })
  .strict() satisfies z.ZodType<AccountResetInput>;

export function registerAccountRoutes(app: Hono<AppEnv>): void {
  /**
   * Reset the account, by group (task 18). Erases the chosen groups of the
   * signed-in account and keeps a backup of every erased row, in one
   * transaction inside the database (`reset_account`, migration 0045). The
   * typed word is checked here as well as on the page: a request that skipped
   * the page has not confirmed.
   */
  app.post('/account/reset', async (context) => {
    const parsed = resetSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      throw badRequest('invalid_body', `expected { groups: (${ACCOUNT_RESET_GROUPS.join(' | ')})[], confirm }`, parsed.error.issues);
    }
    if (parsed.data.confirm !== ACCOUNT_RESET_CONFIRMATION) {
      throw unprocessable('reset_not_confirmed', `type ${ACCOUNT_RESET_CONFIRMATION} to confirm a reset`);
    }
    const groups = ACCOUNT_RESET_GROUPS.filter((group) => parsed.data.groups.includes(group));
    const reset = await resetAccount(currentUserId(context), groups);
    const body: AccountResetResponse = { resetId: reset.reset_id, groups, erased: reset.counts };
    return context.json(body);
  });
}
