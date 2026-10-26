/**
 * Single-use links (D260, migration 0074): a row per link, holding its hash,
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

/** What the installation's settings say about letting a verified stranger in (D243, D305). */
export interface AdmissionRules {
  mode: SignupMode;
  dailyLimit: number;
  /** The retired cap, written only for 0058's CHECK (D279). */
  defaultCapMicroUsd: number;
  /** The installation's clock, whose day the limit counts (`APP_TIMEZONE`). */
  timezone: string;
  /** *approval*'s limit on verified waiting requests (D243), checked again as a link verifies one. */
  maxPendingSignups: number;
}

/**
 * What a sign-up's link must be opened with (D309): the password hash the
 * route checked the typed password against. Opening compares it again inside
 * the transaction, so a sign-up again with a new password between the check
 * and the update finds the link refused, not verified with the old answer.
 */
export interface SignupProof {
  passwordHash: string;
}

export type VerificationResult =
  | { outcome: 'activated' | 'awaiting_approval'; userId: string }
  | { outcome: 'email_changed'; userId: string }
  | { outcome: 'email_taken' | 'expired' | 'used' | 'invalid' }
  /** A sign-up's link opened without its password, or with another (D309); the link stays unused. */
  | { outcome: 'wrong_password' }
  /** Sign-up is closed, or approval's queue is full (D243); the link stays unused until it expires. */
  | { outcome: 'signup_full' };

/** What the route needs before opening a link: whose it is and, for a sign-up's, the password to check. */
export interface VerificationTokenPeek {
  purpose: AuthTokenPurpose;
  /** The address the link went to: the sign-in failures are counted against it. */
  email: string;
  /** The account's password hash, for a `verify_email` link only. */
  passwordHash: string | null;
  /** Unused and unexpired: a used or expired link says so without asking for a password. */
  open: boolean;
}

/** Read a link without opening it or locking anything; null when no link has this hash. */
export function peekVerificationToken(tokenHash: Buffer): Promise<VerificationTokenPeek | null> {
  return queryOne<{ purpose: AuthTokenPurpose; email: string; password_hash: string | null; open: boolean }>(
    `SELECT t.purpose, t.email, CASE WHEN t.purpose = 'verify_email' THEN u.password_hash END AS password_hash,
            t.used_at IS NULL AND t.expires_at > now() AS open
       FROM auth_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1`,
    [tokenHash],
  ).then((row) =>
    row ? { purpose: row.purpose, email: row.email, passwordHash: row.password_hash, open: row.open } : null,
  );
}

const UNIQUE_VIOLATION = '23505';

/**
 * Open a verification link. `verify_email` proves a sign-up's address: under
 * *automatic*, and below today's limit, the account turns `active`; otherwise
 * it waits for the admin, verified. `verify_new_email` makes a pending address
 * the sign-in address and ends every session (as any address change does).
 * A reset link is not a verification link: it is `invalid` here.
 */
export async function useVerificationToken(
  tokenHash: Buffer,
  rules: AdmissionRules,
  proof: SignupProof | null,
): Promise<VerificationResult> {
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
        await client.query<{ status: string; email: string | null; pending_email: string | null; password_hash: string | null }>(
          'SELECT status, email, pending_email, password_hash FROM users WHERE id = $1 FOR UPDATE',
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
        // The mailbox alone is not enough: whoever signed up first with this
        // address chose the password, and it may not be the mailbox's owner (D309).
        if (proof === null || user.password_hash !== proof.passwordHash) return { outcome: 'wrong_password' };
        // The settings row is locked first, so two verifications cannot both
        // take the last place of the day, or of approval's queue.
        await client.query('SELECT 1 FROM installation_settings FOR UPDATE');
        if (rules.mode === 'closed') return { outcome: 'signup_full' };
        if (rules.mode === 'approval') {
          // Unverified requests are not counted at sign-up (D304), so many can
          // be waiting for their links at once; the limit holds here, where one
          // joins the admin's queue.
          const waiting = await client.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM users
              WHERE status = 'pending' AND role = 'user' AND email_verified_at IS NOT NULL`,
          );
          if ((waiting.rows[0]?.count ?? 0) >= rules.maxPendingSignups) return { outcome: 'signup_full' };
        }
        await client.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [token.user_id]);
        await markUsed();
        if (rules.mode !== 'automatic') return { outcome: 'awaiting_approval', userId: token.user_id };
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
 * `days` (D304). Never an account, a verified request or a rejected one. Such a
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
