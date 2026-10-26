/**
 * The session cookie (D160, D261).
 *
 * A session is `base64url(payload).base64url(hmac)`, and the payload names a
 * row of `user_sessions` by a random secret (`sid`). The HMAC makes the cookie
 * unforgeable; the row makes it revocable - signing out deletes it, and a
 * copied cookie dies with it. The row keeps only the secret's SHA-256, so a
 * leaked database or backup holds no usable session.
 *
 * The payload still carries the user's `session_version` as `ver`, a second
 * check D261 keeps until it is shown to add nothing: the request pipeline
 * accepts a session only while its row exists and has not expired, the user
 * is `active` and the versions match.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'traders_session';

/** Random bytes in a session's secret: 256 bits, beyond guessing. */
export const SESSION_SECRET_BYTES = 32;

interface SessionPayload {
  sid: string;
  uid: string;
  ver: number;
  exp: number;
}

/** What a valid cookie claims; the caller still checks it against the session row and the user. */
export interface SessionClaim {
  /** The secret whose hash names the session's row. */
  secret: string;
  userId: string;
  sessionVersion: number;
}

function sign(data: string, signingSecret: string): string {
  return createHmac('sha256', signingSecret).update(data).digest('base64url');
}

/**
 * Constant-time string comparison, so response timing cannot reveal how much of a guessed secret
 * was right. Length-checked first because `timingSafeEqual` throws when the lengths differ.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/** A new session's secret, carried only in its cookie. */
export function newSessionSecret(): string {
  return randomBytes(SESSION_SECRET_BYTES).toString('base64url');
}

/** What `user_sessions.token_hash` holds for a secret. */
export function sessionTokenHash(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

export function createSessionToken(claim: SessionClaim, signingSecret: string, expiresAt: Date): string {
  const payload: SessionPayload = {
    sid: claim.secret,
    uid: claim.userId,
    ver: claim.sessionVersion,
    exp: expiresAt.getTime(),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${sign(encoded, signingSecret)}`;
}

export function verifySessionToken(token: string | undefined, signingSecret: string): SessionClaim | null {
  if (!token) return null;
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return null;
  if (!safeEqual(signature, sign(encoded, signingSecret))) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SessionPayload;
    // A cookie from before the sessions table (no `sid`) is not a session: its
    // holder signs in once more (D261).
    if (
      typeof payload.sid !== 'string' ||
      payload.sid === '' ||
      typeof payload.uid !== 'string' ||
      payload.uid === '' ||
      typeof payload.exp !== 'number' ||
      typeof payload.ver !== 'number'
    ) {
      return null;
    }
    if (payload.exp <= Date.now()) return null;
    return { secret: payload.sid, userId: payload.uid, sessionVersion: payload.ver };
  } catch {
    return null;
  }
}
