/**
 * A signed-in session for API tests that are about something other than
 * signing in.
 *
 * The cookie is minted directly rather than earned through `/auth/login`, so a
 * suite about holdings does not have to mock credentials and pay for an argon2
 * hash; `authApi.test.ts` is where the login route itself is tested. The
 * session middleware still reads the session with its user (D160, D261), so a
 * suite's mocked queries need `getSessionUser: mockedSessionUser` beside a
 * `getUser` that returns a row with `ACTIVE_SESSION`'s fields: the session is
 * then whatever that suite's `getUser` says the user is.
 */

import { SESSION_COOKIE, createSessionToken } from '../src/http/auth.js';

/** The seeded user's id (migration 0001), which every suite signs in as. */
export const TEST_USER_ID = '00000000-0000-0000-0000-000000000001';

/** Every suite's `SESSION_SECRET`. */
export const TEST_SESSION_SECRET = 'test-session-secret-value';

/** The id of the session row every minted cookie stands for. */
export const TEST_SESSION_ID = '5e551000-0000-4000-8000-000000000001';

/** The fields a user row needs for the session middleware to accept its cookie. */
export const ACTIVE_SESSION = {
  status: 'active',
  session_version: 1,
  password_must_change: false,
  pending_email: null,
} as const;

/** How long a minted cookie claims to live; the mocked row decides the rest. */
const MINTED_COOKIE_TTL_MS = 60 * 60 * 1000;

/** A `Cookie` header value for `userId`'s session at `sessionVersion`. */
export function sessionCookie(userId = TEST_USER_ID, sessionVersion = 1, secret = `test-secret-${userId}`): string {
  const token = createSessionToken(
    { secret, userId, sessionVersion },
    TEST_SESSION_SECRET,
    new Date(Date.now() + MINTED_COOKIE_TTL_MS),
  );
  return `${SESSION_COOKIE}=${token}`;
}

/**
 * A suite's `getSessionUser`: the user its own (mocked) `getUser` returns, on
 * `TEST_SESSION_ID`. Imported late, inside the call, so it reads the mocked
 * module and works inside a hoisted `vi.mock` factory.
 */
export async function mockedSessionUser(userId: string): Promise<Record<string, unknown> | null> {
  const { getUser } = await import('../src/db/queries.js');
  const user = await getUser(userId);
  return user ? { ...user, session_id: TEST_SESSION_ID } : null;
}
