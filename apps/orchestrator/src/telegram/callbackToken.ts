/**
 * Signed, single-use tokens for Telegram inline buttons.
 *
 * **The threat this exists for is a forwarded message.** A Telegram message with
 * inline buttons can be forwarded to anybody, and the buttons keep working -
 * Telegram tells us which chat tapped, and nothing else. So `callback_data` has
 * to carry its own authenticity: if it did not, anyone holding a forwarded
 * alert could approve somebody else's proposal, and the only evidence would be
 * a ledger row attributed to the wrong person.
 *
 * Three independent things have to hold before a tap is a decision, and each
 * fails closed on its own:
 *
 *   1. **The HMAC verifies** - the payload was minted by us and not edited. A
 *      tampered proposal id or a flipped action changes the signature.
 *   2. **The chat is bound to the user** the token names. Checked at the
 *      webhook, not here: forwarding moves the message, not the binding.
 *   3. **The nonce has not been used.** Enforced by the unique index on
 *      `proposal_transitions.idempotency_key` - a replay loses the insert and
 *      is answered with the current state, which is what F3 asks for anyway.
 *
 * **Everything must fit in 64 bytes.** That is Telegram's hard limit on
 * `callback_data`, and it is the reason this file exists at all rather than a
 * line of `JSON.stringify`: a UUID alone is 36 characters, so JSON with a
 * signature is roughly double the budget. The encoding below is therefore
 * compact rather than readable - raw bytes, base64url, truncated MAC - and the
 * cost is paid once, here, with a test that asserts the limit.
 *
 * The alternative was a table of callback rows with a short opaque id. It was
 * rejected because it makes every rendered button a database write, and the
 * rows would need their own expiry sweep; the signature already carries what
 * the row would have held, and the nonce table we need anyway is the one the
 * audit trail already keeps.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Telegram refuses `callback_data` longer than this, in bytes. */
export const MAX_CALLBACK_DATA_BYTES = 64;

/** Bytes of HMAC kept. 128 bits is far beyond forgeable and fits the budget. */
const MAC_BYTES = 16;

/** Bytes of randomness in the nonce, which only has to be unique, not secret. */
const NONCE_BYTES = 8;

/** Wire spellings, one character each - the budget does not stretch to words. */
const ACTION_CODES = { approve: 'a', reject: 'r', snooze: 's' } as const;

export type CallbackAction = keyof typeof ACTION_CODES;

const ACTIONS_BY_CODE = new Map<string, CallbackAction>(
  Object.entries(ACTION_CODES).map(([action, code]) => [code, action as CallbackAction]),
);

export interface CallbackPayload {
  proposalId: string;
  action: CallbackAction;
  /** Unique per rendered button. Burned on use, so a replay cannot decide twice. */
  nonce: string;
}

const base64url = (buffer: Buffer): string => buffer.toString('base64url');

/**
 * A UUID as its 16 raw bytes rather than its 36-character spelling.
 *
 * This single choice is most of the byte budget: base64url of 16 bytes is 22
 * characters against the 36 a hyphenated UUID costs.
 */
function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== 32 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new Error(`not a uuid: ${uuid}`);
  }
  return Buffer.from(hex, 'hex');
}

function bytesToUuid(buffer: Buffer): string {
  const hex = buffer.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

function sign(secret: string, body: string): Buffer {
  return createHmac('sha256', secret).update(body).digest().subarray(0, MAC_BYTES);
}

/** A fresh nonce for one rendered button. */
export function mintNonce(): string {
  return base64url(randomBytes(NONCE_BYTES));
}

/**
 * Encode one button's payload.
 *
 * Format: `<proposal><action><nonce>.<mac>` - the MAC covers everything before
 * the separator, so neither the proposal nor the action can be edited in
 * isolation.
 */
export function encodeCallbackData(payload: CallbackPayload, secret: string): string {
  const body = `${base64url(uuidToBytes(payload.proposalId))}${ACTION_CODES[payload.action]}${payload.nonce}`;
  const data = `${body}.${base64url(sign(secret, body))}`;
  if (Buffer.byteLength(data, 'utf8') > MAX_CALLBACK_DATA_BYTES) {
    // Thrown rather than truncated: a token cut to fit would fail verification
    // at the other end, and the resulting bug reads as "approvals randomly stop
    // working" rather than as an encoding mistake.
    throw new Error(
      `callback_data is ${Buffer.byteLength(data, 'utf8')} bytes, over Telegram's ${MAX_CALLBACK_DATA_BYTES}`,
    );
  }
  return data;
}

/**
 * Verify and decode. Returns null for anything that does not check out.
 *
 * One null for every kind of failure, deliberately: a caller that could tell a
 * bad signature from a malformed body would be able to tell a forgery attempt
 * from a truncated message, and the only consumer of that distinction is
 * somebody probing the endpoint.
 */
export function decodeCallbackData(data: string, secret: string): CallbackPayload | null {
  const separator = data.lastIndexOf('.');
  if (separator <= 0) return null;

  const body = data.slice(0, separator);
  const provided = Buffer.from(data.slice(separator + 1), 'base64url');
  const expected = sign(secret, body);
  // Length-checked first because timingSafeEqual throws on a mismatch, and a
  // thrown exception here would be a denial of service dressed as a 500.
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;

  // Only now is the body known to be ours, so parsing it cannot be steered by
  // an attacker: verify, then interpret, never the other way round.
  const proposalBytes = Buffer.from(body.slice(0, 22), 'base64url');
  if (proposalBytes.length !== 16) return null;
  const action = ACTIONS_BY_CODE.get(body.slice(22, 23));
  if (action === undefined) return null;
  const nonce = body.slice(23);
  if (nonce.length === 0) return null;

  return { proposalId: bytesToUuid(proposalBytes), action, nonce };
}
