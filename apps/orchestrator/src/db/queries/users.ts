import { query, queryOne } from '../pool.js';

export type UserRole = 'user' | 'admin';
export type UserStatus = 'pending' | 'active' | 'rejected' | 'disabled';

export interface UserRow {
  id: string;
  email: string | null;
  base_currency: string;
  timezone: string;
  role: UserRole;
  /** A session is accepted only while this is `active` (D160). */
  status: UserStatus;
  /** Copied into the session cookie; a bump ends every session the user holds (D160). */
  session_version: number;
  /** The admin's one-time password (D162): nothing but a password change until it is changed. */
  password_must_change: boolean;
}

const USER_COLUMNS =
  'id, email, base_currency, timezone, role, status, session_version, password_must_change';

/**
 * The users scheduled work runs for (D161): active ones, oldest first, so the
 * round-robin's order is stable from one ask to the next. Pending, rejected and
 * disabled users have no scheduled runs.
 */
export async function listActiveUserIds(): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM users WHERE status = 'active' ORDER BY created_at, id`,
  );
  return rows.map((row) => row.id);
}

export function getUser(userId: string): Promise<UserRow | null> {
  return queryOne<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [userId]);
}

export interface UserCredentialsRow {
  id: string;
  status: UserStatus;
  password_hash: string | null;
}

/** Email is unique regardless of case (0058's `users_email_lower_key`), so this is one row or none. */
export function getUserCredentialsByEmail(email: string): Promise<UserCredentialsRow | null> {
  return queryOne<UserCredentialsRow>(
    'SELECT id, status, password_hash FROM users WHERE lower(email) = lower($1)',
    [email],
  );
}

export function getPasswordHash(userId: string): Promise<string | null> {
  return queryOne<{ password_hash: string | null }>(
    'SELECT password_hash FROM users WHERE id = $1',
    [userId],
  ).then((row) => row?.password_hash ?? null);
}

/** For the admin's user list (D162). */
export async function recordSignIn(userId: string): Promise<void> {
  await query('UPDATE users SET last_sign_in_at = now() WHERE id = $1', [userId]);
}

/**
 * A new password, which ends every session the user holds - this one included,
 * so the caller reissues its cookie with the returned version - and clears the
 * one-time password's "must change".
 */
export async function changePassword(userId: string, passwordHash: string): Promise<UserRow | null> {
  return queryOne<UserRow>(
    `UPDATE users
        SET password_hash = $2,
            password_must_change = false,
            session_version = session_version + 1
      WHERE id = $1
  RETURNING ${USER_COLUMNS}`,
    [userId, passwordHash],
  );
}

/**
 * The user's own zone (D163): their "today", quiet hours, digest and snapshot
 * day. Not a credential, so no session ends; the caller validates the name.
 */
export function changeTimeZone(userId: string, timezone: string): Promise<UserRow | null> {
  return queryOne<UserRow>(
    `UPDATE users SET timezone = $2 WHERE id = $1 RETURNING ${USER_COLUMNS}`,
    [userId, timezone],
  );
}

const UNIQUE_VIOLATION = '23505';

/**
 * A new sign-in address, which ends every session the user holds - this one
 * included, so the caller reissues its cookie - as a password change does
 * (D160). `'taken'` when another account already signs in with it: the unique
 * index on `lower(email)` decides, so two users racing for one address cannot
 * both win.
 */
export async function changeEmail(userId: string, email: string): Promise<UserRow | 'taken' | null> {
  try {
    return await queryOne<UserRow>(
      `UPDATE users
          SET email = $2,
              session_version = session_version + 1
        WHERE id = $1
    RETURNING ${USER_COLUMNS}`,
      [userId, email],
    );
  } catch (error) {
    if ((error as { code?: string }).code === UNIQUE_VIOLATION) return 'taken';
    throw error;
  }
}

/**
 * The bootstrap script's one statement (D179): the installation's admin gets
 * this email and password, and every session they held ends. Null when there
 * is no admin to give them to.
 */
export function setAdminCredentials(email: string, passwordHash: string): Promise<UserRow | null> {
  return queryOne<UserRow>(
    `UPDATE users
        SET email = $1,
            password_hash = $2,
            password_must_change = false,
            session_version = session_version + 1
      WHERE role = 'admin'
  RETURNING ${USER_COLUMNS}`,
    [email, passwordHash],
  );
}

/** How many admins there are, and how many can sign in with a password (D179). */
export function adminPasswordState(): Promise<{ admins: number; withPassword: number }> {
  return queryOne<{ admins: number; with_password: number }>(
    `SELECT count(*)::int AS admins, count(password_hash)::int AS with_password
       FROM users WHERE role = 'admin'`,
  ).then((row) => ({ admins: row?.admins ?? 0, withPassword: row?.with_password ?? 0 }));
}
