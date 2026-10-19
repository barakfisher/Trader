/**
 * A signed-in session for API tests that are about something other than
 * signing in.
 *
 * The cookie is minted directly rather than earned through `/auth/login`, so a
 * suite about holdings does not have to mock credentials and pay for an argon2
 * hash; `authApi.test.ts` is where the login route itself is tested. The
 * session middleware still reads the user (D160), so a suite's mocked
 * `getUser` must return a row with `ACTIVE_SESSION`'s fields.
 */

import { SESSION_COOKIE, createSessionToken } from '../src/http/auth.js';

/** The seeded user's id (migration 0001), which every suite signs in as. */
export const TEST_USER_ID = '00000000-0000-0000-0000-000000000001';

/** Every suite's `SESSION_SECRET`. */
export const TEST_SESSION_SECRET = 'test-session-secret-value';

/** The fields a user row needs for the session middleware to accept its cookie. */
export const ACTIVE_SESSION = {
  status: 'active',
  session_version: 1,
  password_must_change: false,
} as const;

/** A `Cookie` header value for `userId`'s session at `sessionVersion`. */
export function sessionCookie(userId = TEST_USER_ID, sessionVersion = 1): string {
  const token = createSessionToken({ userId, sessionVersion }, TEST_SESSION_SECRET, 1);
  return `${SESSION_COOKIE}=${token}`;
}
