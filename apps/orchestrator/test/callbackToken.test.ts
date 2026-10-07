/**
 * Signed callback tokens for Telegram inline buttons.
 *
 * The threat model is a forwarded message: the buttons keep working wherever
 * the message ends up, so the payload has to carry its own authenticity. These
 * tests pin the three things that make a tap trustworthy - the signature
 * covers every field, nothing survives being edited, and the whole token fits
 * inside Telegram's hard 64-byte limit.
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_CALLBACK_DATA_BYTES,
  MAX_CALLBACK_PRICE_MINOR,
  decodeCallbackData,
  encodeCallbackData,
  mintNonce,
  type CallbackAction,
} from '../src/telegram/callbackToken.js';

const SECRET = 'a-test-signing-secret';
const PROPOSAL = '11111111-2222-3333-4444-555555555555';

const payload = (overrides: Partial<{ proposalId: string; action: CallbackAction }> = {}) => ({
  proposalId: PROPOSAL,
  action: 'approve' as CallbackAction,
  nonce: mintNonce(),
  ...overrides,
});

describe('encodeCallbackData', () => {
  it('round-trips a payload', () => {
    const original = payload();
    const decoded = decodeCallbackData(encodeCallbackData(original, SECRET), SECRET);
    expect(decoded).toEqual(original);
  });

  it.each(['approve', 'reject', 'snooze'] as CallbackAction[])(
    'round-trips the %s action',
    (action) => {
      const original = payload({ action });
      expect(decodeCallbackData(encodeCallbackData(original, SECRET), SECRET)?.action).toBe(action);
    },
  );

  it('fits inside Telegram’s callback_data limit', () => {
    // The constraint the whole encoding exists for. Asserted against the named
    // constant rather than 64, so the limit is stated in exactly one place.
    const data = encodeCallbackData(payload(), SECRET);
    expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(MAX_CALLBACK_DATA_BYTES);
  });

  it('gives every button a different nonce', () => {
    // Two buttons on one message, or the same proposal re-announced: each tap
    // has to be distinguishable, or the second one is indistinguishable from a
    // replay of the first.
    expect(mintNonce()).not.toBe(mintNonce());
  });

  it('refuses a proposal id that is not a uuid rather than encoding nonsense', () => {
    expect(() => encodeCallbackData(payload({ proposalId: 'not-a-uuid' }), SECRET)).toThrow();
  });
});

describe('a Confirm carries the previewed price (D47, D62)', () => {
  const confirm = (priceMinor: bigint) => ({ ...payload({ action: 'confirm' }), priceMinor });

  it.each([1n, 99n, 23_868n, 2_097_151n, 2_097_152n, MAX_CALLBACK_PRICE_MINOR])(
    'round-trips %s minor units',
    (price) => {
      const original = confirm(price);
      expect(decodeCallbackData(encodeCallbackData(original, SECRET), SECRET)).toEqual(original);
    },
  );

  it('fits the limit at the largest price it may carry', () => {
    const data = encodeCallbackData(confirm(MAX_CALLBACK_PRICE_MINOR), SECRET);
    expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(MAX_CALLBACK_DATA_BYTES);
  });

  it('refuses a price it cannot carry, and a price on anything but a confirm', () => {
    expect(() => encodeCallbackData(confirm(MAX_CALLBACK_PRICE_MINOR + 1n), SECRET)).toThrow();
    expect(() => encodeCallbackData(confirm(0n), SECRET)).toThrow();
    expect(() => encodeCallbackData({ ...payload(), priceMinor: 100n }, SECRET)).toThrow();
    expect(() => encodeCallbackData(payload({ action: 'confirm' }), SECRET)).toThrow();
  });

  it('rejects a token whose price was edited', () => {
    // The fill is checked against this price: editing it must break the MAC.
    const data = encodeCallbackData(confirm(23_868n), SECRET);
    const separator = data.lastIndexOf('.');
    const body = data.slice(0, separator);
    const other = encodeCallbackData(confirm(99_999n), SECRET);
    const otherPrice = other.slice(34, other.lastIndexOf('.'));
    expect(decodeCallbackData(`${body.slice(0, 34)}${otherPrice}${data.slice(separator)}`, SECRET)).toBeNull();
  });
});

describe('decodeCallbackData', () => {
  it('rejects a token signed with a different secret', () => {
    const data = encodeCallbackData(payload(), SECRET);
    expect(decodeCallbackData(data, 'a-different-secret')).toBeNull();
  });

  it('rejects a token whose action was edited', () => {
    // The MAC covers the action, so approving something the button said to
    // reject is not a matter of flipping one character.
    const data = encodeCallbackData(payload({ action: 'reject' }), SECRET);
    const tampered = `${data.slice(0, 22)}a${data.slice(23)}`;
    expect(decodeCallbackData(tampered, SECRET)).toBeNull();
  });

  it('rejects a token whose proposal id was edited', () => {
    // Otherwise a forwarded alert becomes a way to approve somebody else's
    // proposal - the whole reason the payload is signed.
    const data = encodeCallbackData(payload(), SECRET);
    const swapped = `A${data.slice(1)}`;
    expect(decodeCallbackData(swapped, SECRET)).toBeNull();
  });

  it('rejects a token whose nonce was edited', () => {
    const data = encodeCallbackData(payload(), SECRET);
    const separator = data.lastIndexOf('.');
    const tampered = `${data.slice(0, separator - 1)}X${data.slice(separator)}`;
    expect(decodeCallbackData(tampered, SECRET)).toBeNull();
  });

  it.each([
    ['empty', ''],
    ['no separator', 'abcdefghijklmnop'],
    ['separator only', '.'],
    ['signature only', '.abcd'],
    ['body only', 'abcd.'],
    ['not base64url at all', '!!!!.!!!!'],
  ])('rejects a malformed token (%s) without throwing', (_label, data) => {
    // A webhook is a public endpoint: anything at all arrives there, and a
    // thrown exception would be a denial of service dressed as a 500.
    expect(() => decodeCallbackData(data, SECRET)).not.toThrow();
    expect(decodeCallbackData(data, SECRET)).toBeNull();
  });

  it('rejects a truncated signature rather than comparing a short buffer', () => {
    const data = encodeCallbackData(payload(), SECRET);
    expect(decodeCallbackData(data.slice(0, data.length - 4), SECRET)).toBeNull();
  });

  it('rejects an unknown action code even when the signature is valid', () => {
    // Defence in depth: a future action added to the minting side and not the
    // reading side must not decode as one of the existing ones.
    const original = payload();
    const data = encodeCallbackData(original, SECRET);
    // Re-sign a body with an action code nothing maps to, so the MAC is genuine.
    const body = data.slice(0, data.lastIndexOf('.'));
    const forgedBody = `${body.slice(0, 22)}z${body.slice(23)}`;
    const { createHmac } = require('node:crypto') as typeof import('node:crypto');
    const mac = createHmac('sha256', SECRET).update(forgedBody).digest().subarray(0, 16);
    expect(decodeCallbackData(`${forgedBody}.${mac.toString('base64url')}`, SECRET)).toBeNull();
  });
});
