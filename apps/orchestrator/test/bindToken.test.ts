/**
 * The "Connect Telegram" deep-link token.
 *
 * Two constraints shape it and both are pinned here: it must fit in 64
 * characters, and it must contain only characters a `t.me/...?start=` link can
 * carry. A token that violates the second is silently mangled by Telegram
 * rather than rejected, which is very hard to diagnose from the far side.
 */

import { describe, expect, it } from 'vitest';

import {
  BIND_TOKEN_TTL_MS,
  MAX_START_PARAM_CHARS,
  decodeBindToken,
  encodeBindToken,
} from '../src/telegram/bindToken.js';

const SECRET = 'a-test-signing-secret';
const USER = '11111111-2222-3333-4444-555555555555';
const NOW = new Date('2026-09-17T12:00:00.000Z');

describe('encodeBindToken', () => {
  it('round-trips the user it names', () => {
    const { token } = encodeBindToken(USER, SECRET, NOW);
    expect(decodeBindToken(token, SECRET, NOW)?.userId).toBe(USER);
  });

  it('fits inside the deep-link length limit', () => {
    const { token } = encodeBindToken(USER, SECRET, NOW);
    expect(token.length).toBeLessThanOrEqual(MAX_START_PARAM_CHARS);
  });

  it('uses only characters a deep link can carry', () => {
    // Telegram mangles anything outside this set instead of refusing it.
    const { token } = encodeBindToken(USER, SECRET, NOW);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('expires the token a fixed interval after minting', () => {
    // Asserted against the named constant, so retuning the TTL does not break
    // a test that is about the expiry being carried at all.
    const { payload } = encodeBindToken(USER, SECRET, NOW);
    expect(payload.expiresAt.getTime()).toBe(NOW.getTime() + BIND_TOKEN_TTL_MS);
  });

  it('gives every link a different nonce', () => {
    // The nonce is the single-use mechanism: two links minted back to back must
    // not redeem as each other.
    const first = encodeBindToken(USER, SECRET, NOW);
    const second = encodeBindToken(USER, SECRET, NOW);
    expect(first.payload.nonce).not.toBe(second.payload.nonce);
    expect(first.token).not.toBe(second.token);
  });

  it('refuses a user id that is not a uuid', () => {
    expect(() => encodeBindToken('nope', SECRET, NOW)).toThrow();
  });
});

describe('decodeBindToken', () => {
  it('rejects a token signed with a different secret', () => {
    const { token } = encodeBindToken(USER, SECRET, NOW);
    expect(decodeBindToken(token, 'other-secret', NOW)).toBeNull();
  });

  it('rejects a token whose user was edited', () => {
    // The point of signing: a link cannot be retargeted at another account.
    const { token } = encodeBindToken(USER, SECRET, NOW);
    expect(decodeBindToken(`A${token.slice(1)}`, SECRET, NOW)).toBeNull();
  });

  it('rejects a token past its expiry', () => {
    const { token } = encodeBindToken(USER, SECRET, NOW);
    const later = new Date(NOW.getTime() + BIND_TOKEN_TTL_MS + 1);
    expect(decodeBindToken(token, SECRET, later)).toBeNull();
  });

  it('treats the expiry instant itself as expired', () => {
    const { token } = encodeBindToken(USER, SECRET, NOW);
    const exactly = new Date(NOW.getTime() + BIND_TOKEN_TTL_MS);
    expect(decodeBindToken(token, SECRET, exactly)).toBeNull();
  });

  it('accepts a token a moment before it expires', () => {
    const { token } = encodeBindToken(USER, SECRET, NOW);
    const justBefore = new Date(NOW.getTime() + BIND_TOKEN_TTL_MS - 1);
    expect(decodeBindToken(token, SECRET, justBefore)?.userId).toBe(USER);
  });

  it.each([
    ['empty', ''],
    ['too short', 'abc'],
    ['too long', 'a'.repeat(100)],
    ['illegal characters', '!'.repeat(63)],
  ])('rejects a malformed token (%s) without throwing', (_label, token) => {
    // /start arrives from a public endpoint; anything at all can be typed there.
    expect(() => decodeBindToken(token, SECRET, NOW)).not.toThrow();
    expect(decodeBindToken(token, SECRET, NOW)).toBeNull();
  });

  it('returns the nonce, so redemption can spend it', () => {
    const { token, payload } = encodeBindToken(USER, SECRET, NOW);
    expect(decodeBindToken(token, SECRET, NOW)?.nonce).toBe(payload.nonce);
  });
});
