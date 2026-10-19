/**
 * The session cookie (D160).
 *
 * A session is `base64url(payload).base64url(hmac)`. There is no session table:
 * the HMAC makes the cookie unforgeable, and it carries the user's
 * `session_version` as `ver`. The request pipeline reads the user on every
 * request and accepts the session only while the user is `active` and the
 * versions match, so disabling a user or changing a password ends sessions at
 * once without a table to keep.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'traders_session';

interface SessionPayload {
  uid: string;
  ver: number;
  exp: number;
}

/** What a valid cookie claims; the caller still checks it against the user. */
export interface SessionClaim {
  userId: string;
  sessionVersion: number;
}

function sign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

export function createSessionToken(
  claim: SessionClaim,
  secret: string,
  ttlHours: number,
): string {
  const payload: SessionPayload = {
    uid: claim.userId,
    ver: claim.sessionVersion,
    exp: Date.now() + ttlHours * 3600 * 1000,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${sign(encoded, secret)}`;
}

export function verifySessionToken(token: string | undefined, secret: string): SessionClaim | null {
  if (!token) return null;
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return null;
  if (!safeEqual(signature, sign(encoded, secret))) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SessionPayload;
    // A cookie from before `ver` existed is not a session: its holder signs in once more.
    if (!payload.uid || typeof payload.exp !== 'number' || typeof payload.ver !== 'number') {
      return null;
    }
    if (payload.exp <= Date.now()) return null;
    return { userId: payload.uid, sessionVersion: payload.ver };
  } catch {
    return null;
  }
}
