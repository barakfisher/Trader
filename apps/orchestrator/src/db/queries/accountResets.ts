import type { AccountResetGroup } from '@traders/shared';

import { queryOne } from '../pool.js';

export interface AccountResetRow {
  reset_id: string;
  counts: Record<string, number>;
}

/**
 * Erase the chosen groups of one account and keep a backup of every erased
 * row, in one transaction (task 18). The whole reset is the database function
 * `reset_account` (migration 0045): the only path by which the append-only
 * ledger loses a row, and one this role can call but not reproduce - it holds
 * no DELETE on fills or cash movements. The admin gate has already written the
 * `admin_audit` row by the time this runs (decision 84).
 */
export async function resetAccount(userId: string, groups: AccountResetGroup[]): Promise<AccountResetRow> {
  const row = await queryOne<AccountResetRow>(
    `SELECT reset_id::text AS reset_id, counts
       FROM reset_account($1::uuid, $2::text[])`,
    [userId, groups],
  );
  if (!row) throw new Error('reset_account returned no row');
  return row;
}
