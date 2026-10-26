/**
 * A signed-in device's session (D261, migration 0071): created at sign-in,
 * read with the user on every request, ended by signing out - this one, one
 * other, all others - and swept once expired. Ending *every* session of a user
 * is not here: it happens inside the statement that changes the credential or
 * the status (`users.ts`, `adminUsers.ts`), so no path can change one without
 * the other.
 */

import { query, queryOne } from '../pool.js';
import { qualifiedUserColumns, type UserRow } from './users.js';

/** The signed-in user, with the session the request came in on. */
export interface SessionUserRow extends UserRow {
  session_id: string;
}

export interface SessionRow {
  id: string;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  user_agent: string | null;
  ip_address: string | null;
}

export interface NewSession {
  userId: string;
  tokenHash: Buffer;
  ttlHours: number;
  userAgent: string | null;
  ipAddress: string | null;
  /** The most sessions the user may hold once this one exists (D302). */
  maxPerUser: number;
}

/**
 * A new session, expiring `ttlHours` from now and never extended (D295). The
 * user's oldest sessions go in the same statement, so that with this one they
 * hold at most `maxPerUser` (D302). Two sign-ins at the same instant can each
 * keep the same survivors and leave one too many; the next sign-in trims it.
 */
export function createSession(session: NewSession): Promise<{ id: string; expires_at: Date }> {
  // `OFFSET NULL` is no offset at all: a missing cap would end every other session.
  if (!Number.isInteger(session.maxPerUser) || session.maxPerUser < 1) {
    return Promise.reject(new Error(`maxPerUser must be a positive integer, got ${String(session.maxPerUser)}`));
  }
  return queryOne<{ id: string; expires_at: Date }>(
    `WITH evicted AS (
       DELETE FROM user_sessions
        WHERE id IN (SELECT id FROM user_sessions
                      WHERE user_id = $1
                      ORDER BY created_at DESC, id DESC
                     OFFSET $6 - 1)
     )
     INSERT INTO user_sessions (user_id, token_hash, expires_at, user_agent, ip_address)
     VALUES ($1, $2, now() + make_interval(hours => $3), $4, $5)
     RETURNING id, expires_at`,
    [session.userId, session.tokenHash, session.ttlHours, session.userAgent, session.ipAddress, session.maxPerUser],
  ).then((row) => {
    if (!row) throw new Error('the session was not created');
    return row;
  });
}

/**
 * The user a cookie names, with its session - one indexed lookup on the
 * secret's hash, joined to the user the request reads anyway (D160). The
 * session must be the cookie's user's and unexpired; the caller checks the
 * status and the version. `last_seen_at` moves in the same round trip, at
 * most once every `touchSeconds`, so a busy page writes a few times an hour
 * rather than on every request.
 */
export function getSessionUser(
  userId: string,
  tokenHash: Buffer,
  touchSeconds: number,
): Promise<SessionUserRow | null> {
  return queryOne<SessionUserRow>(
    `WITH found AS (
       SELECT id, user_id, last_seen_at
         FROM user_sessions
        WHERE token_hash = $2 AND user_id = $1 AND expires_at > now()
     ), touched AS (
       UPDATE user_sessions SET last_seen_at = now()
        WHERE id IN (SELECT id FROM found WHERE last_seen_at < now() - make_interval(secs => $3))
     )
     SELECT ${qualifiedUserColumns('u')}, found.id AS session_id
       FROM found JOIN users u ON u.id = found.user_id`,
    [userId, tokenHash, touchSeconds],
  );
}

/** The user's unexpired sessions, most recently used first. */
export function listSessions(userId: string): Promise<SessionRow[]> {
  return query<SessionRow>(
    `SELECT id, created_at, last_seen_at, expires_at, user_agent, ip_address
       FROM user_sessions
      WHERE user_id = $1 AND expires_at > now()
      ORDER BY last_seen_at DESC, id`,
    [userId],
  );
}

/**
 * Whether this session of the user's began within `minutes` (D264): an account
 * with no password confirms a deletion by having just signed in.
 */
export async function sessionSignedInWithin(userId: string, sessionId: string, minutes: number): Promise<boolean> {
  const row = await queryOne<{ recent: boolean }>(
    `SELECT created_at > now() - make_interval(mins => $3) AS recent
       FROM user_sessions WHERE user_id = $1 AND id = $2`,
    [userId, sessionId, minutes],
  );
  return row?.recent ?? false;
}

/** End one of the user's sessions; false when the user has no such session. */
export async function deleteSession(userId: string, sessionId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    'DELETE FROM user_sessions WHERE user_id = $1 AND id = $2 RETURNING id',
    [userId, sessionId],
  );
  return rows.length > 0;
}

/**
 * End every session of the user's but `keepSessionId`. Expired rows go too, but
 * the count is of the live ones - the sessions the list showed - so "signed
 * out 2 other devices" never names one the user could not see.
 */
export async function deleteOtherSessions(userId: string, keepSessionId: string): Promise<number> {
  const row = await queryOne<{ ended: number }>(
    `WITH gone AS (
       DELETE FROM user_sessions WHERE user_id = $1 AND id <> $2 RETURNING expires_at
     )
     SELECT count(*) FILTER (WHERE expires_at > now())::int AS ended FROM gone`,
    [userId, keepSessionId],
  );
  return row?.ended ?? 0;
}

/** The installation's sweep (`auth_sweep`): every expired row, whoever's; how many. */
export async function deleteExpiredSessions(): Promise<number> {
  const row = await queryOne<{ deleted: number }>(
    `WITH gone AS (
       DELETE FROM user_sessions WHERE expires_at <= now() RETURNING 1
     )
     SELECT count(*)::int AS deleted FROM gone`,
  );
  return row?.deleted ?? 0;
}
