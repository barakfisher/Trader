/**
 * Single-use links (D260, migration 0072): a row per link, holding its hash,
 * purpose, the address it was sent to, its expiry and when it was used.
 *
 * Opening a link is one transaction: the token row is locked, checked and
 * marked used together with what it does, so two clicks - or two tabs - cannot
 * both act, and a failure part-way leaves the link unused.
 */

import type { SignupMode } from '@traders/shared';

import { query, queryOne, transaction } from '../pool.js';

export type AuthTokenPurpose = 'verify_email' | 'verify_new_email' | 'reset_password';

export interface NewAuthToken {
  userId: string;
  purpose: AuthTokenPurpose;
  /** Where the link is sent: a link for an address the account no longer has proves nothing. */
  email: string;
  tokenHash: Buffer;
  ttlHours: number;
}

/** Write a link, cancelling the user's earlier unused link of the same purpose (D260). */
export async function issueAuthToken(token: NewAuthToken): Promise<void> {
  await query(
    `WITH cancelled AS (
       DELETE FROM auth_tokens WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL
     )
     INSERT INTO auth_tokens (user_id, purpose, email, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5))`,
    [token.userId, token.purpose, token.email, token.tokenHash, token.ttlHours],
  );
}

/** What the installation's settings say about letting a verified stranger in (D243, D300). */
export interface AdmissionRules {
  mode: SignupMode;
  dailyLimit: number;
  /** The retired cap, written only for 0058's CHECK (D279). */
  defaultCapMicroUsd: number;
  /** The installation's clock, whose day the limit counts (`APP_TIMEZONE`). */
  timezone: string;
}

export type VerificationResult =
  | { outcome: 'activated' | 'awaiting_approval'; userId: string }
  | { outcome: 'email_changed'; userId: string }
  | { outcome: 'email_taken' | 'expired' | 'used' | 'invalid' };

const UNIQUE_VIOLATION = '23505';

/**
 * Open a verification link. `verify_email` proves a sign-up's address: under
 * *automatic*, and below today's limit, the account turns `active`; otherwise
 * it waits for the admin, verified. `verify_new_email` makes a pending address
 * the sign-in address and ends every session (as any address change does).
 * A reset link is not a verification link: it is `invalid` here.
 */
export async function useVerificationToken(tokenHash: Buffer, rules: AdmissionRules): Promise<VerificationResult> {
  try {
    return await transaction(async (client) => {
      const token = (
        await client.query<{ id: string; user_id: string; purpose: AuthTokenPurpose; email: string; expired: boolean; used: boolean }>(
          `SELECT id, user_id, purpose, email, expires_at <= now() AS expired, used_at IS NOT NULL AS used
             FROM auth_tokens WHERE token_hash = $1 FOR UPDATE`,
          [tokenHash],
        )
      ).rows[0];
      if (!token || token.purpose === 'reset_password') return { outcome: 'invalid' };
      if (token.used) return { outcome: 'used' };
      if (token.expired) return { outcome: 'expired' };

      const user = (
        await client.query<{ status: string; email: string | null; pending_email: string | null }>(
          'SELECT status, email, pending_email FROM users WHERE id = $1 FOR UPDATE',
          [token.user_id],
        )
      ).rows[0];
      const markUsed = () => client.query('UPDATE auth_tokens SET used_at = now() WHERE id = $1', [token.id]);

      if (token.purpose === 'verify_email') {
        // Only a request still waiting, for the address the link was sent to.
        if (!user || user.status !== 'pending' || user.email?.toLowerCase() !== token.email.toLowerCase()) {
          await markUsed();
          return { outcome: 'invalid' };
        }
        await client.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [token.user_id]);
        await markUsed();
        if (rules.mode !== 'automatic') return { outcome: 'awaiting_approval', userId: token.user_id };
        // The settings row is locked so two verifications cannot both take the last place of the day.
        await client.query('SELECT 1 FROM installation_settings FOR UPDATE');
        const activated = await client.query(
          `UPDATE users
              SET status = 'active', llm_cap_micro_usd = $2, approved_at = now(), approved_automatically = true
            WHERE id = $1
              AND (SELECT count(*) FROM users
                    WHERE approved_automatically
                      AND approved_at >= date_trunc('day', now() AT TIME ZONE $3) AT TIME ZONE $3) < $4`,
          [token.user_id, rules.defaultCapMicroUsd, rules.timezone, rules.dailyLimit],
        );
        return { outcome: (activated.rowCount ?? 0) > 0 ? 'activated' : 'awaiting_approval', userId: token.user_id };
      }

      // verify_new_email: only the change still waiting, for this address.
      if (!user || user.pending_email?.toLowerCase() !== token.email.toLowerCase()) {
        await markUsed();
        return { outcome: 'invalid' };
      }
      const taken = await client.query(
        'SELECT 1 FROM users WHERE lower(email) = lower($1) AND id <> $2',
        [token.email, token.user_id],
      );
      await markUsed();
      if ((taken.rowCount ?? 0) > 0) {
        await client.query('UPDATE users SET pending_email = NULL WHERE id = $1', [token.user_id]);
        return { outcome: 'email_taken' };
      }
      // A new sign-in address ends every session, as a change did before D259 (D160, D261).
      await client.query(
        `UPDATE users
            SET email = pending_email, pending_email = NULL, email_verified_at = now(),
                session_version = session_version + 1
          WHERE id = $1`,
        [token.user_id],
      );
      await client.query('DELETE FROM user_sessions WHERE user_id = $1', [token.user_id]);
      return { outcome: 'email_changed', userId: token.user_id };
    });
  } catch (error) {
    // Another account took the address between the check and the update; the link stays unused.
    if ((error as { code?: string }).code === UNIQUE_VIOLATION) return { outcome: 'email_taken' };
    throw error;
  }
}

/** Ask for a new sign-in address (D259): stored as pending; the current one stays until it is confirmed. */
export async function setPendingEmail(userId: string, email: string): Promise<void> {
  await query('UPDATE users SET pending_email = $2 WHERE id = $1', [userId, email]);
}

/** The installation's sweep (`auth_sweep`): links past their retention, whoever's; how many. */
export async function deleteExpiredAuthTokens(retentionDays: number): Promise<number> {
  const row = await queryOne<{ deleted: number }>(
    `WITH gone AS (
       DELETE FROM auth_tokens WHERE expires_at <= now() - make_interval(days => $1) RETURNING 1
     )
     SELECT count(*)::int AS deleted FROM gone`,
    [retentionDays],
  );
  return row?.deleted ?? 0;
}

/**
 * The installation's sweep: sign-ups whose address was never proven within
 * `days` (D299). Never an account, a verified request or a rejected one. Such a
 * request never signed in, so nothing of it outlives the row but what cascades.
 */
export async function deleteStaleUnverifiedSignups(days: number): Promise<number> {
  const row = await queryOne<{ deleted: number }>(
    `WITH gone AS (
       DELETE FROM users
        WHERE status = 'pending' AND role = 'user' AND email_verified_at IS NULL
          AND created_at <= now() - make_interval(days => $1)
       RETURNING 1
     )
     SELECT count(*)::int AS deleted FROM gone`,
    [days],
  );
  return row?.deleted ?? 0;
}
