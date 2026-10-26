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
  /** An address change waiting for its link (D259); `email` stays the sign-in address until then. */
  pending_email: string | null;
}

const USER_COLUMNS =
  'id, email, base_currency, timezone, role, status, session_version, password_must_change, pending_email';

/** `USER_COLUMNS` for a query that names `users` by `alias`. */
export function qualifiedUserColumns(alias: string): string {
  return USER_COLUMNS.split(', ')
    .map((column) => `${alias}.${column}`)
    .join(', ');
}

/**
 * Wraps an `UPDATE users ... RETURNING` so the same statement deletes every
 * session of each user it updated (D261): a credential or status change and
 * the end of the sessions it should end cannot come apart. A caller that keeps
 * its device signed in issues a new session afterwards.
 */
function endingSessions(update: string): string {
  return `WITH updated AS (${update}),
     ended AS (DELETE FROM user_sessions WHERE user_id IN (SELECT id FROM updated))
     SELECT * FROM updated`;
}

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
  /** Read with the hash, so a sign-in can tell that the password changed while it was checked (D297). */
  session_version: number;
  /** The address the link went to, for "confirm your email first" (D301). */
  email: string | null;
  /** A pending request whose address was never proven is waiting for its link, not for the admin (D259). */
  email_verified: boolean;
}

/** Email is unique regardless of case (0058's `users_email_lower_key`), so this is one row or none. */
export function getUserCredentialsByEmail(email: string): Promise<UserCredentialsRow | null> {
  return queryOne<UserCredentialsRow>(
    `SELECT id, status, password_hash, session_version, email, email_verified_at IS NOT NULL AS email_verified
       FROM users WHERE lower(email) = lower($1)`,
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
 * so the caller issues a new session for this device - and clears the
 * one-time password's "must change".
 */
export async function changePassword(userId: string, passwordHash: string): Promise<UserRow | null> {
  return queryOne<UserRow>(
    endingSessions(`UPDATE users
        SET password_hash = $2,
            password_must_change = false,
            session_version = session_version + 1
      WHERE id = $1
  RETURNING ${USER_COLUMNS}`),
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

/**
 * Whether another account signs in with `email` (any case). Asked when a
 * change is requested, so a person who knows their own password hears "taken"
 * at once rather than after opening a link; the unique index on `lower(email)`
 * still decides when the link is opened (`useVerificationToken`).
 */
export async function emailInUse(email: string, exceptUserId: string): Promise<boolean> {
  const row = await queryOne<{ taken: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM users WHERE lower(email) = lower($1) AND id <> $2) AS taken',
    [email, exceptUserId],
  );
  return row?.taken ?? false;
}

/**
 * The bootstrap script's one statement (D179): the installation's admin gets
 * this email and password, and every session they held ends. Null when there
 * is no admin to give them to.
 */
export function setAdminCredentials(email: string, passwordHash: string): Promise<UserRow | null> {
  return queryOne<UserRow>(
    endingSessions(`UPDATE users
        SET email = $1,
            password_hash = $2,
            password_must_change = false,
            session_version = session_version + 1
      WHERE role = 'admin'
  RETURNING ${USER_COLUMNS}`),
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
