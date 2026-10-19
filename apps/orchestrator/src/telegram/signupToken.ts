/**
 * Signed buttons on the admin's sign-up request message (D156, D184).
 *
 * The same construction as `callbackToken.ts` - raw bytes, base64url, a
 * truncated HMAC, inside Telegram's 64 bytes - under its own domain tag, so a
 * proposal button can never pass as a sign-up decision or the other way round.
 *
 * **No nonce (D188).** A proposal button burns one because Approve-Undo-Approve
 * are all legitimate taps on the same proposal. A request moves one way out of
 * `pending`, and every decision is an UPDATE conditional on that state
 * (`queries/signups.ts`), so a replay finds nothing to change. The chat must
 * still be an active admin's: forwarding moves the message, not the binding.
 *
 * Format: `<user><action>[<cap>].<mac>`. Approve carries the monthly cap in
 * micro-USD, signed with the rest, so the amount applied is the one the button
 * showed - never one an edited button names.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { LLM_CAP_CEILING_MICRO_USD } from '@traders/shared';

import { bytesToUint, bytesToUuid, UUID_CHARS, uintToBytes, uuidToBytes } from './callbackBytes.js';
import { MAX_CALLBACK_DATA_BYTES } from './callbackToken.js';

const MAC_BYTES = 16;
const DOMAIN = 'telegram-signup-v1';

/** Approve with a cap; Reject; Custom shows the preset amounts (D184). */
const ACTION_CODES = { approve: 'a', reject: 'r', custom: 'c' } as const;

export type SignupAction = keyof typeof ACTION_CODES;

const ACTIONS_BY_CODE = new Map<string, SignupAction>(
  Object.entries(ACTION_CODES).map(([action, code]) => [code, action as SignupAction]),
);

/**
 * The cap travels as cap + 1: a varint carries positive numbers, and $0 is a
 * cap an admin may give (approved, but spending nothing).
 */
const CAP_WIRE_MAX = BigInt(LLM_CAP_CEILING_MICRO_USD) + 1n;

export type SignupPayload =
  | { userId: string; action: 'approve'; capMicroUsd: number }
  | { userId: string; action: 'reject' | 'custom' };

function sign(secret: string, body: string): Buffer {
  return createHmac('sha256', secret).update(`${DOMAIN}:${body}`).digest().subarray(0, MAC_BYTES);
}

export function encodeSignupData(payload: SignupPayload, secret: string): string {
  const cap =
    payload.action === 'approve'
      ? uintToBytes(BigInt(payload.capMicroUsd) + 1n, CAP_WIRE_MAX).toString('base64url')
      : '';
  const body = `${uuidToBytes(payload.userId).toString('base64url')}${ACTION_CODES[payload.action]}${cap}`;
  const data = `${body}.${sign(secret, body).toString('base64url')}`;
  if (Buffer.byteLength(data, 'utf8') > MAX_CALLBACK_DATA_BYTES) {
    throw new Error(`callback_data is ${Buffer.byteLength(data, 'utf8')} bytes, over Telegram's ${MAX_CALLBACK_DATA_BYTES}`);
  }
  return data;
}

/** Verify, then interpret. One null for every failure, as `decodeCallbackData`. */
export function decodeSignupData(data: string, secret: string): SignupPayload | null {
  const separator = data.lastIndexOf('.');
  if (separator <= 0) return null;
  const body = data.slice(0, separator);
  const provided = Buffer.from(data.slice(separator + 1), 'base64url');
  const expected = sign(secret, body);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

  const userBytes = Buffer.from(body.slice(0, UUID_CHARS), 'base64url');
  if (userBytes.length !== 16) return null;
  const action = ACTIONS_BY_CODE.get(body.slice(UUID_CHARS, UUID_CHARS + 1));
  if (action === undefined) return null;
  const rest = body.slice(UUID_CHARS + 1);
  const userId = bytesToUuid(userBytes);

  if (action !== 'approve') return rest === '' ? { userId, action } : null;
  const cap = rest === '' ? null : bytesToUint(Buffer.from(rest, 'base64url'), CAP_WIRE_MAX);
  return cap === null ? null : { userId, action, capMicroUsd: Number(cap - 1n) };
}
