import { query, queryOne } from '../pool.js';
import type { UserStatus } from './users.js';

/**
 * Sign-up requests (D156, D184-D188): a `users` row in `pending`, decided by
 * the admin from Telegram or the Admin page.
 *
 * **Every decision is a conditional UPDATE from the state it starts from**
 * (`WHERE status = 'pending'`). That is the whole of the replay defence: a
 * second tap on Approve, a tap on a message already decided on the page, or two
 * tabs racing all find the row moved on and change nothing, so the Telegram
 * buttons need no nonce table (D188).
 */

export type SignupCreation =
  | { outcome: 'created'; userId: string }
  /** The email is already a request or an account: nothing written, nobody told (D185). */
  | { outcome: 'exists' }
  /** The installation's limit on waiting requests is reached (D156). */
  | { outcome: 'closed' };

/**
 * Write a request, with its settings row in the request's language, in one
 * statement. The limit is read in the same statement, so a request cannot slip
 * in after the count; two submitted in the same instant can still both pass it,
 * which overshoots a household-sized limit by one and costs one extra message.
 * `ON CONFLICT` on `lower(email)` makes "one request per email" the unique
 * index's decision, not a SELECT's.
 */
export async function createSignupRequest(input: {
  email: string;
  passwordHash: string;
  timezone: string;
  language: string;
}): Promise<SignupCreation> {
  const row = await queryOne<{ open: boolean; user_id: string | null }>(
    `WITH limits AS (
       SELECT s.max_pending_signups > (SELECT count(*) FROM users WHERE status = 'pending') AS open
         FROM installation_settings s
     ), inserted AS (
       INSERT INTO users (email, password_hash, timezone, status)
       SELECT $1, $2, $3, 'pending' FROM limits WHERE open
       ON CONFLICT ((lower(email))) DO NOTHING
       RETURNING id
     ), settings AS (
       INSERT INTO user_settings (user_id, language)
       SELECT id, $4 FROM inserted
       RETURNING user_id
     )
     SELECT coalesce((SELECT open FROM limits), false) AS open,
            (SELECT user_id FROM settings) AS user_id`,
    [input.email, input.passwordHash, input.timezone, input.language],
  );
  if (!row?.open) return { outcome: 'closed' };
  return row.user_id === null ? { outcome: 'exists' } : { outcome: 'created', userId: row.user_id };
}

export interface SignupRequestRow {
  user_id: string;
  email: string;
  timezone: string;
  status: 'pending' | 'rejected';
  created_at: Date;
}

const REQUEST_COLUMNS = 'id AS user_id, email, timezone, status, created_at';

/** How many rejected requests the Admin page lists; older ones stay in the table. */
export const REJECTED_SIGNUPS_LIMIT = 50;

/** Waiting requests oldest first - the order they asked in - then recent rejections. */
export async function listSignupRequests(): Promise<{
  pending: SignupRequestRow[];
  rejected: SignupRequestRow[];
}> {
  const [pending, rejected] = await Promise.all([
    query<SignupRequestRow>(
      `SELECT ${REQUEST_COLUMNS} FROM users
        WHERE status = 'pending' AND role = 'user' ORDER BY created_at, id`,
    ),
    query<SignupRequestRow>(
      `SELECT ${REQUEST_COLUMNS} FROM users
        WHERE status = 'rejected' AND role = 'user' ORDER BY created_at DESC, id LIMIT $1`,
      [REJECTED_SIGNUPS_LIMIT],
    ),
  ]);
  return { pending, rejected };
}

/** The count on the Admin link (D188). */
export function countPendingSignups(): Promise<number> {
  return queryOne<{ count: number }>(
    `SELECT count(*)::int AS count FROM users WHERE status = 'pending' AND role = 'user'`,
  ).then((row) => row?.count ?? 0);
}

/** One request, for the Telegram message that announces or decides it. */
export function getSignupRequest(userId: string): Promise<{
  user_id: string;
  email: string | null;
  timezone: string;
  status: UserStatus;
  created_at: Date;
} | null> {
  return queryOne(
    `SELECT ${REQUEST_COLUMNS} FROM users WHERE id = $1 AND role = 'user'`,
    [userId],
  );
}

/** Where a request is after a decision was asked for; `gone` when there is no such user. */
export type SignupDecision = { applied: boolean; status: UserStatus | 'gone'; email: string | null };

async function decided(
  userId: string,
  applied: { email: string | null } | null,
  status: UserStatus,
): Promise<SignupDecision> {
  if (applied !== null) return { applied: true, status, email: applied.email };
  const now = await queryOne<{ status: UserStatus; email: string | null }>(
    `SELECT status, email FROM users WHERE id = $1 AND role = 'user'`,
    [userId],
  );
  return { applied: false, status: now?.status ?? 'gone', email: now?.email ?? null };
}

/**
 * Let a waiting user in. The cap is retired (D279): it is written only for
 * 0058's CHECK, from the installation's default, and nothing reads it. The 0058 trigger seeds
 * their primary agent on this very transition, so a pending user never had one.
 */
export async function approveSignup(
  userId: string,
  llmCapMicroUsd: number,
  adminUserId: string,
): Promise<SignupDecision> {
  const row = await queryOne<{ email: string | null }>(
    `UPDATE users
        SET status = 'active', llm_cap_micro_usd = $2, approved_at = now(), approved_by = $3
      WHERE id = $1 AND status = 'pending' AND role = 'user'
  RETURNING email`,
    [userId, llmCapMicroUsd, adminUserId],
  );
  return decided(userId, row, 'active');
}

/** Turn a waiting request down; kept, so the same email cannot ask again (D156). */
export async function rejectSignup(userId: string): Promise<SignupDecision> {
  const row = await queryOne<{ email: string | null }>(
    `UPDATE users SET status = 'rejected'
      WHERE id = $1 AND status = 'pending' AND role = 'user'
  RETURNING email`,
    [userId],
  );
  return decided(userId, row, 'rejected');
}

/**
 * Undo a rejection: the request waits again (D188). Outside the waiting-request
 * limit and with no Telegram message - the admin is the one doing it.
 */
export async function restoreSignup(userId: string): Promise<SignupDecision> {
  const row = await queryOne<{ email: string | null }>(
    `UPDATE users SET status = 'pending'
      WHERE id = $1 AND status = 'rejected' AND role = 'user'
  RETURNING email`,
    [userId],
  );
  return decided(userId, row, 'pending');
}

export interface AdminChatRow {
  user_id: string;
  chat_id: string;
  language: string;
}

/** The chats a new request is announced in: every active admin's (one, today: D155). */
export function listAdminChats(): Promise<AdminChatRow[]> {
  return query<AdminChatRow>(
    `SELECT u.id AS user_id, b.chat_id::text AS chat_id, coalesce(s.language, 'en') AS language
       FROM users u
       JOIN telegram_bindings b ON b.user_id = u.id
  LEFT JOIN user_settings s ON s.user_id = u.id
      WHERE u.role = 'admin' AND u.status = 'active'
      ORDER BY u.created_at`,
  );
}

/** Whether this user is an active admin: a Telegram decision is theirs alone. */
export function isActiveAdmin(userId: string): Promise<boolean> {
  return queryOne<{ ok: boolean }>(
    `SELECT true AS ok FROM users WHERE id = $1 AND role = 'admin' AND status = 'active'`,
    [userId],
  ).then((row) => row !== null);
}
