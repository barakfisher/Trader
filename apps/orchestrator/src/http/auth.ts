/**
 * Session handling for single-user v1.
 *
 * A session is `base64url(payload).base64url(hmac)`. There is no session table:
 * the cookie is self-describing and the HMAC makes it unforgeable, which is all
 * a one-account deployment needs. When real multi-user auth arrives, only this
 * file and the login route change.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'traders_session';

interface SessionPayload {
  uid: string;
  exp: number;
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

export function createSessionToken(userId: string, secret: string, ttlHours: number): string {
  const payload: SessionPayload = {
    uid: userId,
    exp: Date.now() + ttlHours * 3600 * 1000,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${sign(encoded, secret)}`;
}

export function verifySessionToken(token: string | undefined, secret: string): string | null {
  if (!token) return null;
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return null;
  if (!safeEqual(signature, sign(encoded, secret))) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SessionPayload;
    if (!payload.uid || typeof payload.exp !== 'number') return null;
    if (payload.exp <= Date.now()) return null;
    return payload.uid;
  } catch {
    return null;
  }
}

/**
 * Compare the submitted passphrase with the configured one in constant time.
 * Digesting first keeps the comparison length-independent.
 */
export function passphraseMatches(submitted: string, expected: string): boolean {
  const digest = (value: string) => createHmac('sha256', 'passphrase').update(value).digest();
  return timingSafeEqual(digest(submitted), digest(expected));
}
