import { query, queryOne } from '../pool.js';

/**
 * The admin's user list and its actions (D162, D235). Operations only: nothing
 * here reads an account's holdings, proposals, agents or conversations. Every
 * action refuses the admin's own row - an admin locked out uses
 * `scripts/admin-password.sh`, and is never disabled or capped by a click.
 */

export interface AdminUserRow {
  id: string;
  email: string | null;
  role: 'user' | 'admin';
  status: 'active' | 'disabled';
  timezone: string;
  llm_cap_micro_usd: string | null;
  spent_this_month_micro_usd: string;
  own_key_status: 'valid' | 'failed' | null;
  last_sign_in_at: Date | null;
  approved_at: Date | null;
}

/**
 * Active and disabled accounts, the admin first, then by approval. Waiting and
 * rejected requests are the sign-up list's. This month's spend is the cap's own
 * sum (`getMonthlySpend`): installation-paid calls since the start of the month
 * in the user's zone.
 */
export function listUsersForAdmin(): Promise<AdminUserRow[]> {
  return query<AdminUserRow>(
    `-- agent-blind: a user's whole month, every agent's calls and the assistant's (D157).
     SELECT u.id, u.email, u.role, u.status, u.timezone,
            u.llm_cap_micro_usd::text AS llm_cap_micro_usd,
            coalesce((
              SELECT sum(c.cost_micro_usd)
                FROM llm_calls c
               WHERE c.user_id = u.id AND c.paid_by = 'installation'
                 AND c.started_at >= (date_trunc('month', now() AT TIME ZONE u.timezone) AT TIME ZONE u.timezone)
            ), 0)::text AS spent_this_month_micro_usd,
            k.status AS own_key_status,
            u.last_sign_in_at, u.approved_at
       FROM users u
       LEFT JOIN user_llm_keys k ON k.user_id = u.id
      WHERE u.status IN ('active', 'disabled')
      ORDER BY u.role = 'admin' DESC, u.approved_at NULLS FIRST, u.id`,
  );
}

/**
 * Disable or re-enable a user (D235). Disabling bumps `session_version`, which
 * ends every session they hold at once (D160); their data is untouched, and
 * scheduled work skips them while disabled (D161). Null when the user is not
 * in the `from` state, or is the admin.
 */
export function setUserStatus(
  userId: string,
  from: 'active' | 'disabled',
  to: 'active' | 'disabled',
): Promise<{ id: string } | null> {
  return queryOne<{ id: string }>(
    `UPDATE users
        SET status = $3, session_version = session_version + 1
      WHERE id = $1 AND status = $2 AND role <> 'admin'
  RETURNING id`,
    [userId, from, to],
  );
}

/** A user's monthly cap, after approval (D235). Takes effect on their next call. */
export function setUserCap(userId: string, capMicroUsd: number): Promise<{ id: string } | null> {
  return queryOne<{ id: string }>(
    `UPDATE users
        SET llm_cap_micro_usd = $2
      WHERE id = $1 AND role <> 'admin' AND status IN ('active', 'disabled')
  RETURNING id`,
    [userId, capMicroUsd],
  );
}

/**
 * A one-time password (D162): the hash of one the app made, which must be
 * changed at the next sign-in; every session the user holds ends.
 */
export function setOneTimePassword(userId: string, passwordHash: string): Promise<{ id: string } | null> {
  return queryOne<{ id: string }>(
    `UPDATE users
        SET password_hash = $2, password_must_change = true, session_version = session_version + 1
      WHERE id = $1 AND role <> 'admin' AND status IN ('active', 'disabled')
  RETURNING id`,
    [userId, passwordHash],
  );
}
