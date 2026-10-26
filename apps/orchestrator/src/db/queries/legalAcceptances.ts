import { query } from '../pool.js';

/**
 * What each user agreed to (migration 0077, D265): a row per user and legal
 * version. The app's role may add a row and read them, never change or
 * delete one; they go with the user.
 */

/** Record that the user accepted `version`; accepting it again keeps the first time. */
export async function recordLegalAcceptance(userId: string, version: string): Promise<void> {
  await query(
    `INSERT INTO legal_acceptances (user_id, version) VALUES ($1, $2)
     ON CONFLICT (user_id, version) DO NOTHING`,
    [userId, version],
  );
}

/** Whether the user accepted `version`. */
export async function hasAcceptedLegalVersion(userId: string, version: string): Promise<boolean> {
  const rows = await query<{ accepted: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM legal_acceptances WHERE user_id = $1 AND version = $2) AS accepted`,
    [userId, version],
  );
  return rows[0]?.accepted ?? false;
}
