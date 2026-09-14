import { describe, expect, it } from 'vitest';

import { createSessionToken, passphraseMatches, verifySessionToken } from '../src/http/auth.js';

const SECRET = 'a-very-long-test-secret-value';
const USER = '00000000-0000-0000-0000-000000000001';

describe('session tokens', () => {
  it('round-trips a valid token', () => {
    const token = createSessionToken(USER, SECRET, 1);
    expect(verifySessionToken(token, SECRET)).toBe(USER);
  });

  it('rejects a token signed with a different secret', () => {
    const token = createSessionToken(USER, SECRET, 1);
    expect(verifySessionToken(token, 'another-secret-entirely')).toBeNull();
  });

  it('rejects a tampered payload', () => {
    const token = createSessionToken(USER, SECRET, 1);
    const [, signature] = token.split('.');
    const forged = `${Buffer.from(JSON.stringify({ uid: 'attacker', exp: Date.now() + 1000 })).toString('base64url')}.${signature}`;
    expect(verifySessionToken(forged, SECRET)).toBeNull();
  });

  it('rejects an expired token', () => {
    const token = createSessionToken(USER, SECRET, -1);
    expect(verifySessionToken(token, SECRET)).toBeNull();
  });

  it('rejects malformed input', () => {
    expect(verifySessionToken(undefined, SECRET)).toBeNull();
    expect(verifySessionToken('', SECRET)).toBeNull();
    expect(verifySessionToken('no-dot', SECRET)).toBeNull();
    expect(verifySessionToken('not-base64.signature', SECRET)).toBeNull();
  });
});

describe('passphraseMatches', () => {
  it('accepts the exact passphrase and rejects anything else', () => {
    expect(passphraseMatches('correct horse', 'correct horse')).toBe(true);
    expect(passphraseMatches('correct hors', 'correct horse')).toBe(false);
    expect(passphraseMatches('', 'correct horse')).toBe(false);
  });
});
