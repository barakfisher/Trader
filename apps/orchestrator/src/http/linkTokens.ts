/**
 * The secrets inside emailed links (D260): random, sent once, stored only as a
 * SHA-256 in `auth_tokens`, so a leaked database or backup holds no usable link.
 */

import { createHash, randomBytes } from 'node:crypto';

/** Random bytes in a link's secret: 256 bits, beyond guessing. */
export const LINK_TOKEN_BYTES = 32;

/** How long a verification link works (D260's `VERIFY_TOKEN_TTL`). */
export const VERIFY_TOKEN_TTL_HOURS = 24;

/** How long an unverified sign-up waits for its link before the sweep removes it (D304). */
export const UNVERIFIED_SIGNUP_DAYS = 7;

/** How long a used or expired link is kept, so opening it says "used" or "expired" rather than "invalid". */
export const AUTH_TOKEN_RETENTION_DAYS = 7;

export function newLinkToken(): string {
  return randomBytes(LINK_TOKEN_BYTES).toString('base64url');
}

export function linkTokenHash(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

/**
 * The page a link opens, on the origin the request came from - already one of
 * `ALLOWED_ORIGINS`, checked by the Origin gate - so a mail links back to the
 * address the person used: compose, kind, the phone's Tailscale name or the
 * public host.
 *
 * The token rides in the fragment (`#token=`), never the query: a browser does
 * not send the fragment to any server, so it stays out of access logs, proxies
 * and the `Referer` of anything the page loads. The page posts it to the API.
 */
export function pageLink(origin: string, path: string, token?: string, extra: Record<string, string> = {}): string {
  const url = new URL(path, origin);
  if (token !== undefined) url.hash = new URLSearchParams({ token, ...extra }).toString();
  return url.toString();
}

/**
 * A sign-up's link says so (`for=signup`), so the page asks for the password
 * up front (D309). It is a hint for the form only: the server decides from the
 * link's own row whether a password is needed.
 */
export const SIGNUP_LINK_HINT = { for: 'signup' } as const;
