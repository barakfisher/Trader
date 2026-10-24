/**
 * Signing a device in, and what the device list says about it (D261, D294).
 *
 * A session is a row of `user_sessions` plus the signed cookie that names it
 * (`auth.ts`). Issuing one writes both; every way of ending one deletes the
 * row, which is what ends a copied cookie too.
 */

import Bowser from 'bowser';
import type { Context } from 'hono';
import { setCookie } from 'hono/cookie';

import type { SessionDevice } from '@traders/shared';

import { createSession, type SessionRow, type UserRow } from '../db/queries.js';
import type { AppEnv } from './app.js';
import { SESSION_COOKIE, createSessionToken, newSessionSecret, sessionTokenHash } from './auth.js';
import { requestClientAddress } from './clientAddress.js';

/**
 * How stale `last_seen_at` may get before a request moves it: "last seen" is
 * shown to the minute's worth of a human glance, and a write on every request
 * would turn each page load into several writes.
 */
export const SESSION_TOUCH_INTERVAL_SECONDS = 5 * 60;

/** The longest user agent kept (0071's CHECK); a longer one is cut, never refused. */
export const USER_AGENT_MAX_LENGTH = 512;

/**
 * Sign this device in as `user`: a new session row, and the cookie that names
 * it. The row expires `SESSION_TTL_HOURS` from now and is never extended
 * (D295); the cookie lives exactly as long.
 */
export async function issueSession(context: Context<AppEnv>, user: UserRow): Promise<void> {
  const config = context.get('config');
  const secret = newSessionSecret();
  const userAgent = context.req.header('user-agent')?.slice(0, USER_AGENT_MAX_LENGTH) || null;
  const session = await createSession({
    userId: user.id,
    tokenHash: sessionTokenHash(secret),
    ttlHours: config.SESSION_TTL_HOURS,
    userAgent,
    ipAddress: requestClientAddress(context, config.TRUSTED_PROXY_HOPS),
  });
  const token = createSessionToken(
    { secret, userId: user.id, sessionVersion: user.session_version },
    config.SESSION_SECRET,
    session.expires_at,
  );
  setCookie(context, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: config.isProduction,
    path: '/',
    expires: session.expires_at,
  });
  context.set('sessionId', session.id);
}

/**
 * A device as the list shows it: browser and OS read from the stored user
 * agent when the list is asked for, so a better reading later needs no
 * migration (D294). Names are the parser's, in English - they are product
 * names - and null where it found none; the web says "unknown" in the user's
 * language.
 */
export function describeSession(row: SessionRow, currentSessionId: string | undefined): SessionDevice {
  const parsed = parseUserAgent(row.user_agent);
  return {
    id: row.id,
    browser: parsed.browser,
    os: parsed.os,
    deviceType: parsed.deviceType,
    signedInAt: row.created_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    ipAddress: displayedAddress(row.ip_address),
    current: row.id === currentSessionId,
  };
}

/**
 * An IPv4 address as people write it: Node reports one that arrived on an IPv6
 * socket as `::ffff:203.0.113.7`, which reads as a different, stranger address.
 */
function displayedAddress(address: string | null): string | null {
  const mapped = address?.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  return mapped ? mapped[1]! : address;
}

const DEVICE_TYPES = new Set<SessionDevice['deviceType']>(['desktop', 'mobile', 'tablet']);

function parseUserAgent(userAgent: string | null): Pick<SessionDevice, 'browser' | 'os' | 'deviceType'> {
  // `Bowser.parse` throws on an empty string, and a client may send none.
  if (!userAgent) return { browser: null, os: null, deviceType: null };
  const parsed = Bowser.parse(userAgent);
  const deviceType = parsed.platform.type as SessionDevice['deviceType'];
  return {
    browser: parsed.browser.name || null,
    os: parsed.os.name || null,
    deviceType: DEVICE_TYPES.has(deviceType) ? deviceType : null,
  };
}
