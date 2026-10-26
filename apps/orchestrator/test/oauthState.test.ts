/** The OAuth state cookie (D262): signed, short-lived, for one provider. */

import { describe, expect, it } from 'vitest';

const { OAUTH_STATE_TTL_SECONDS, decodeOAuthState, encodeOAuthState } = await import('../src/oauth/stateCookie.js');

const SECRET = 'test-session-secret-value';
const STATE = {
  provider: 'google' as const,
  state: 'the-state',
  codeVerifier: 'the-verifier',
  origin: 'http://localhost:5173',
  intent: 'signin' as const,
  userId: null,
  timezone: 'UTC',
  language: 'en',
  expiresAt: Date.now() + OAUTH_STATE_TTL_SECONDS * 1000,
};

describe('the OAuth state cookie', () => {
  it('reads back what it was given', () => {
    expect(decodeOAuthState(encodeOAuthState(STATE, SECRET), SECRET)).toEqual(STATE);
  });

  it('refuses one signed with another secret, or changed after signing', () => {
    const cookie = encodeOAuthState(STATE, SECRET);
    expect(decodeOAuthState(cookie, 'another-secret-value')).toBeNull();
    const [, signature] = cookie.split('.');
    const forged = Buffer.from(JSON.stringify({ ...STATE, origin: 'https://evil.example' })).toString('base64url');
    expect(decodeOAuthState(`${forged}.${signature}`, SECRET)).toBeNull();
  });

  it('refuses one past its expiry, and anything malformed', () => {
    const cookie = encodeOAuthState(STATE, SECRET);
    expect(decodeOAuthState(cookie, SECRET, STATE.expiresAt + 1)).toBeNull();
    expect(decodeOAuthState(undefined, SECRET)).toBeNull();
    expect(decodeOAuthState('no-dot', SECRET)).toBeNull();
  });
});
