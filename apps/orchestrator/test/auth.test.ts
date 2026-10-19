import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createSessionToken, verifySessionToken } from '../src/http/auth.js';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  hashPassword,
  passwordMatches,
  passwordProblem,
} from '../src/http/password.js';

const SECRET = 'a-very-long-test-secret-value';
const CLAIM = { userId: '00000000-0000-0000-0000-000000000001', sessionVersion: 3 };

const encode = (payload: unknown) => Buffer.from(JSON.stringify(payload)).toString('base64url');

describe('session tokens', () => {
  it('round-trips a valid token with its session version', () => {
    const token = createSessionToken(CLAIM, SECRET, 1);
    expect(verifySessionToken(token, SECRET)).toEqual(CLAIM);
  });

  it('rejects a token signed with a different secret', () => {
    const token = createSessionToken(CLAIM, SECRET, 1);
    expect(verifySessionToken(token, 'another-secret-entirely')).toBeNull();
  });

  it('rejects a tampered payload', () => {
    const token = createSessionToken(CLAIM, SECRET, 1);
    const [, signature] = token.split('.');
    const forged = `${encode({ uid: 'attacker', ver: 1, exp: Date.now() + 1000 })}.${signature}`;
    expect(verifySessionToken(forged, SECRET)).toBeNull();
  });

  it('rejects a token from before the session version existed', () => {
    // Correctly signed, so only the missing `ver` can refuse it: its holder signs in once more.
    const encoded = encode({ uid: CLAIM.userId, exp: Date.now() + 60_000 });
    const signature = createHmac('sha256', SECRET).update(encoded).digest('base64url');
    expect(verifySessionToken(`${encoded}.${signature}`, SECRET)).toBeNull();
  });

  it('rejects an expired token', () => {
    const token = createSessionToken(CLAIM, SECRET, -1);
    expect(verifySessionToken(token, SECRET)).toBeNull();
  });

  it('rejects malformed input', () => {
    expect(verifySessionToken(undefined, SECRET)).toBeNull();
    expect(verifySessionToken('', SECRET)).toBeNull();
    expect(verifySessionToken('no-dot', SECRET)).toBeNull();
    expect(verifySessionToken('not-base64.signature', SECRET)).toBeNull();
  });
});

describe('passwords (D181)', () => {
  it('accepts lengths within the rule and names what is wrong otherwise', () => {
    expect(passwordProblem('x'.repeat(PASSWORD_MIN_LENGTH))).toBeNull();
    expect(passwordProblem('x'.repeat(PASSWORD_MAX_LENGTH))).toBeNull();
    expect(passwordProblem('x'.repeat(PASSWORD_MIN_LENGTH - 1))).toBe('too_short');
    expect(passwordProblem('x'.repeat(PASSWORD_MAX_LENGTH + 1))).toBe('too_long');
  });

  it('counts characters, not UTF-16 units', () => {
    // Twelve emoji are twelve characters and twenty-four code units.
    expect(passwordProblem('🔑'.repeat(PASSWORD_MIN_LENGTH))).toBeNull();
    expect(passwordProblem('🔑'.repeat(PASSWORD_MIN_LENGTH - 1))).toBe('too_short');
  });

  it('hashes with argon2id and verifies only the same password', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(stored).toMatch(/^\$argon2id\$/);
    expect(await passwordMatches('correct horse battery staple', stored)).toBe(true);
    expect(await passwordMatches('correct horse battery stapl', stored)).toBe(false);
  });

  it('treats a missing or malformed stored hash as a mismatch', async () => {
    expect(await passwordMatches('anything at all', null)).toBe(false);
    expect(await passwordMatches('anything at all', 'not a hash')).toBe(false);
  });
});
