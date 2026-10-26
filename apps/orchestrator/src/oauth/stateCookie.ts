/**
 * What a sign-in through Google or GitHub carries from its start to its
 * callback (D262): the `state` the provider must hand back, PKCE's code
 * verifier, where the browser came from, and why it is signing in. Signed with
 * the session secret and kept in a short-lived HttpOnly cookie, so a callback
 * that did not start in this browser is refused - the CSRF guard of OAuth.
 */

import { createHmac, randomBytes } from 'node:crypto';

import { OAUTH_PROVIDERS, type OAuthProviderName } from '@traders/shared';

import { safeEqual } from '../http/auth.js';

export const OAUTH_STATE_COOKIE = 'traders_oauth';

/** Long enough to sign in at the provider, short enough that a stale cookie is gone. */
export const OAUTH_STATE_TTL_SECONDS = 10 * 60;

export interface OAuthState {
  provider: OAuthProviderName;
  state: string;
  codeVerifier: string;
  /** One of `ALLOWED_ORIGINS`: the redirect URI and where the browser returns. */
  origin: string;
  /** `link` comes from Settings, signed in as `userId`; `signin` from the sign-in page. */
  intent: 'signin' | 'link';
  userId: string | null;
  /** For a new account: the browser's zone and language (D163). */
  timezone: string;
  language: string;
  expiresAt: number;
}

/** A random value for `state` or PKCE: 256 bits, base64url. */
export function oauthSecret(): string {
  return randomBytes(32).toString('base64url');
}

function sign(data: string, secret: string): string {
  return createHmac('sha256', `oauth-state:${secret}`).update(data).digest('base64url');
}

export function encodeOAuthState(value: OAuthState, secret: string): string {
  const data = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${data}.${sign(data, secret)}`;
}

/** The state a cookie holds, or null when it is missing, forged, expired or malformed. */
export function decodeOAuthState(cookie: string | undefined, secret: string, now = Date.now()): OAuthState | null {
  if (!cookie) return null;
  const [data, signature] = cookie.split('.');
  if (!data || !signature || !safeEqual(signature, sign(data, secret))) return null;
  try {
    const value = JSON.parse(Buffer.from(data, 'base64url').toString()) as OAuthState;
    if (typeof value.expiresAt !== 'number' || value.expiresAt <= now) return null;
    if (!(OAUTH_PROVIDERS as readonly string[]).includes(value.provider)) return null;
    return value;
  } catch {
    return null;
  }
}
