/**
 * The installation's erase (D264, `account_erase`): accounts past their
 * deletion date, and - in *automatic* signup - rejected requests past their
 * retention. The erase itself is the database function `erase_account`
 * (migration 0076): this role cannot delete history (fills, movements, scans),
 * and the function refuses anything but a closed account past its date or a
 * rejected request, whoever calls it.
 */

import { query, queryOne } from '../pool.js';

/** Closed accounts whose date has come, oldest first. */
export async function listAccountsDueForErase(): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM users
      WHERE status = 'closed' AND deletion_due_at <= now()
      ORDER BY deletion_due_at, id`,
  );
  return rows.map((row) => row.id);
}

/** Requests rejected more than `days` ago, oldest first. */
export async function listRejectedSignupsOlderThan(days: number): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM users
      WHERE status = 'rejected' AND role = 'user' AND rejected_at <= now() - make_interval(days => $1)
      ORDER BY rejected_at, id`,
    [days],
  );
  return rows.map((row) => row.id);
}

/**
 * Erase one account and every row it owns; shared market data stays, and the
 * admin audit keeps its rows with the id cleared. False when the function
 * refused - the account was reopened since it was listed, or is not one it
 * erases.
 */
export async function eraseAccount(userId: string): Promise<boolean> {
  const row = await queryOne<{ erased: boolean }>('SELECT erase_account($1::uuid) AS erased', [userId]);
  return row?.erased ?? false;
}
