/**
 * Sign-in through Google or GitHub (D262, D263): `user_identities` (0075), one
 * row per provider account linked to a Traders account, found by the
 * provider's stable subject id - never by email, which a person can change at
 * the provider.
 */

import type { OAuthProviderName } from '@traders/shared';

import { query, queryOne, transaction } from '../pool.js';
import { admitVerified, type AdmissionRules } from './authTokens.js';
import type { UserStatus } from './users.js';

const UNIQUE_VIOLATION = '23505';

/** The account a provider identity signs in to, or null when it is linked to none. */
export function getIdentityUser(
  provider: OAuthProviderName,
  subject: string,
): Promise<{ user_id: string; status: UserStatus } | null> {
  return queryOne<{ user_id: string; status: UserStatus }>(
    `SELECT i.user_id, u.status FROM user_identities i JOIN users u ON u.id = i.user_id
      WHERE i.provider = $1 AND i.subject = $2`,
    [provider, subject],
  );
}

/** An account whose sign-in address is `email`, for D263's automatic link. */
export function getAccountByEmail(email: string): Promise<{
  id: string;
  status: UserStatus;
  role: 'admin' | 'user';
  email_verified: boolean;
} | null> {
  return queryOne(
    `SELECT id, status, role, email_verified_at IS NOT NULL AS email_verified
       FROM users WHERE lower(email) = lower($1)`,
    [email],
  );
}

export type LinkOutcome = 'linked' | 'already_linked' | 'taken';

/**
 * Link a provider identity to an account. `taken`: that provider account is
 * linked to another Traders account; `already_linked`: this account already
 * has one of that provider (one per provider, 0075).
 */
export async function linkIdentity(input: {
  userId: string;
  provider: OAuthProviderName;
  subject: string;
  email: string | null;
}): Promise<LinkOutcome> {
  try {
    await query(
      `INSERT INTO user_identities (user_id, provider, subject, email) VALUES ($1, $2, $3, $4)`,
      [input.userId, input.provider, input.subject, input.email],
    );
    return 'linked';
  } catch (error) {
    if ((error as { code?: string; constraint?: string }).code !== UNIQUE_VIOLATION) throw error;
    return (error as { constraint?: string }).constraint === 'user_identities_one_per_provider' ? 'already_linked' : 'taken';
  }
}

/**
 * Link an identity to a request still waiting for its link, by the provider's
 * word that the address is theirs (D263, D314): the request's password goes -
 * whoever signed up first with the address chose it, and the provider has
 * just shown that the mailbox belongs to someone else (D309's attack) - and
 * the request is admitted as a verified one would be.
 */
export async function claimUnverifiedRequest(
  input: { userId: string; provider: OAuthProviderName; subject: string; email: string },
  rules: AdmissionRules,
): Promise<'activated' | 'awaiting_approval' | 'signup_full' | 'taken'> {
  try {
    return await transaction(async (client) => {
      const claimed = await client.query(
        `UPDATE users SET password_hash = NULL
          WHERE id = $1 AND status = 'pending' AND email_verified_at IS NULL AND lower(email) = lower($2)`,
        [input.userId, input.email],
      );
      if ((claimed.rowCount ?? 0) === 0) return 'taken';
      await client.query(
        `INSERT INTO user_identities (user_id, provider, subject, email) VALUES ($1, $2, $3, $4)`,
        [input.userId, input.provider, input.subject, input.email],
      );
      await client.query("DELETE FROM auth_tokens WHERE user_id = $1 AND purpose = 'verify_email'", [input.userId]);
      const admitted = await admitVerified(client, input.userId, rules);
      // Full: nothing is kept - the identity, the cleared password and all.
      if (admitted === 'signup_full') throw new SignupFull();
      return admitted;
    });
  } catch (error) {
    if (error instanceof SignupFull) return 'signup_full';
    if ((error as { code?: string }).code === UNIQUE_VIOLATION) return 'taken';
    throw error;
  }
}

class SignupFull extends Error {}

export type OAuthSignupResult =
  | { outcome: 'activated' | 'awaiting_approval'; userId: string }
  | { outcome: 'signup_full' | 'exists' | 'taken' };

/**
 * A new account from a provider identity whose address the provider vouched
 * for (D263): no password, its address verified, admitted by the
 * installation's rules (D243) in the same transaction - so a full queue or a
 * closed installation leaves nothing behind.
 */
export async function createOAuthAccount(
  input: {
    email: string;
    provider: OAuthProviderName;
    subject: string;
    timezone: string;
    language: string;
  },
  rules: AdmissionRules,
): Promise<OAuthSignupResult> {
  try {
    return await transaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, timezone, status, email_verified_at)
         VALUES ($1, NULL, $2, 'pending', now())
         ON CONFLICT ((lower(email))) DO NOTHING
         RETURNING id`,
        [input.email, input.timezone],
      );
      const userId = inserted.rows[0]?.id;
      if (!userId) return { outcome: 'exists' as const };
      await client.query('INSERT INTO user_settings (user_id, language) VALUES ($1, $2)', [userId, input.language]);
      await client.query(
        'INSERT INTO user_identities (user_id, provider, subject, email) VALUES ($1, $2, $3, $4)',
        [userId, input.provider, input.subject, input.email],
      );
      const admitted = await admitVerified(client, userId, rules);
      if (admitted === 'signup_full') throw new SignupFull();
      return { outcome: admitted, userId };
    });
  } catch (error) {
    if (error instanceof SignupFull) return { outcome: 'signup_full' };
    if ((error as { code?: string }).code === UNIQUE_VIOLATION) return { outcome: 'taken' };
    throw error;
  }
}

export interface IdentityRow {
  provider: OAuthProviderName;
  email: string | null;
  created_at: Date;
}

/** The providers linked to an account, for Settings. */
export function listIdentities(userId: string): Promise<IdentityRow[]> {
  return query<IdentityRow>(
    'SELECT provider, email, created_at FROM user_identities WHERE user_id = $1 ORDER BY provider',
    [userId],
  );
}

/**
 * Unlink a provider (D263). Refused when it is the account's only way to sign
 * in - no password and no other provider - so nobody locks themselves out.
 */
export async function unlinkIdentity(userId: string, provider: OAuthProviderName): Promise<'unlinked' | 'last_method' | 'not_linked'> {
  // The account's row is locked first, so two unlinks at once - Google and
  // GitHub - cannot each see the other still there and leave no way in.
  return transaction(async (client) => {
    const account = (
      await client.query<{ has_password: boolean }>(
        'SELECT password_hash IS NOT NULL AS has_password FROM users WHERE id = $1 FOR UPDATE',
        [userId],
      )
    ).rows[0];
    const linked = (await client.query<{ provider: OAuthProviderName }>('SELECT provider FROM user_identities WHERE user_id = $1', [userId]))
      .rows;
    if (!account || !linked.some((row) => row.provider === provider)) return 'not_linked';
    if (!account.has_password && linked.length === 1) return 'last_method';
    await client.query('DELETE FROM user_identities WHERE user_id = $1 AND provider = $2', [userId, provider]);
    return 'unlinked';
  });
}
