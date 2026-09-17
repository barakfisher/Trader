/**
 * The signed, expiring, single-use token behind "Connect Telegram".
 *
 * It travels as the `start` parameter of a `t.me/<bot>?start=<token>` deep link,
 * which constrains the encoding twice over and in a different way from
 * `callbackToken.ts`:
 *
 *   - **64 characters**, same as `callback_data`; and
 *   - **`[A-Za-z0-9_-]` only**, which `callback_data` does not restrict.
 *
 * The second constraint is why this format has no separator at all. The callback
 * token can afford a `.` between body and signature; a deep link cannot, so the
 * fields are fixed-width and read by offset. That is less forgiving of future
 * change, which is stated here rather than discovered later: adding a field
 * means a new layout, not an extra delimiter.
 *
 * **Nothing is written when a token is minted.** The token carries its own user,
 * expiry and nonce, all under an HMAC, so opening the settings page three times
 * and never tapping the link leaves no rows behind - and therefore no table of
 * unredeemed tokens to expire and no sweep to write for it. An unredeemed token
 * simply stops verifying when its expiry passes.
 *
 * Single-use is enforced at redemption, by the primary key on
 * `telegram_bind_tokens.nonce`. Writing a row first and flipping a `used` flag
 * later was the alternative, and it fails in the classic way: check, then write,
 * with a window in between that two taps can both pass through.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Telegram's limit on the deep-link `start` parameter, in characters. */
export const MAX_START_PARAM_CHARS = 64;

/** How long a connect link stays usable. Long enough to switch apps and tap. */
export const BIND_TOKEN_TTL_MS = 15 * 60 * 1000;

const MAC_BYTES = 16;
const NONCE_BYTES = 8;

/**
 * Field widths in base64url characters. Read by offset, so these *are* the
 * format - a change here is a change to every link already in somebody's chat.
 */
const USER_CHARS = 22; // 16 raw uuid bytes
const EXPIRY_CHARS = 8; // 6 bytes of epoch milliseconds: good past the year 10000
const NONCE_CHARS = 11; // 8 random bytes
const EXPIRY_BYTES = 6;

export interface BindTokenPayload {
  userId: string;
  nonce: string;
  expiresAt: Date;
}

const base64url = (buffer: Buffer): string => buffer.toString('base64url');

function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== 32 || !/^[0-9a-f]+$/i.test(hex)) throw new Error(`not a uuid: ${uuid}`);
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

/** Epoch milliseconds as six big-endian bytes. */
function encodeExpiry(at: Date): Buffer {
  const buffer = Buffer.alloc(EXPIRY_BYTES);
  buffer.writeUIntBE(at.getTime(), 0, EXPIRY_BYTES);
  return buffer;
}

/**
 * Domain tag mixed into every signature here.
 *
 * Bind tokens and callback tokens are signed with the same key, so the tag is
 * what stops one being presented as the other. Their layouts differ today and
 * a swap would almost certainly fail to parse - but "almost certainly fails to
 * parse" is not a security property, and the tag costs one string.
 */
const DOMAIN = 'telegram-bind-v1';

function sign(secret: string, body: string): Buffer {
  return createHmac('sha256', secret)
    .update(`${DOMAIN}:${body}`)
    .digest()
    .subarray(0, MAC_BYTES);
}

/** Mint a connect link's token. Writes nothing; the signature carries the state. */
export function encodeBindToken(
  userId: string,
  secret: string,
  now: Date = new Date(),
): { token: string; payload: BindTokenPayload } {
  const expiresAt = new Date(now.getTime() + BIND_TOKEN_TTL_MS);
  const nonce = base64url(randomBytes(NONCE_BYTES));
  const body = `${base64url(uuidToBytes(userId))}${base64url(encodeExpiry(expiresAt))}${nonce}`;
  const token = `${body}${base64url(sign(secret, body))}`;

  if (token.length > MAX_START_PARAM_CHARS) {
    // Thrown rather than truncated, for the same reason as the callback token:
    // a link cut to fit fails verification at the far end, and the bug then
    // reads as "connecting randomly does not work".
    throw new Error(`bind token is ${token.length} chars, over Telegram's ${MAX_START_PARAM_CHARS}`);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(token)) {
    // base64url should guarantee this; asserted because a deep link containing
    // anything else is silently mangled by Telegram rather than rejected, and
    // that failure is very hard to read from the far side.
    throw new Error('bind token contains characters a deep link cannot carry');
  }
  return { token, payload: { userId, nonce, expiresAt } };
}

/**
 * Verify a token and return what it claims, or null.
 *
 * Expiry is checked here, alongside the signature, because both are properties
 * of the token itself. Whether the nonce has already been spent is *not* checked
 * here - that is a fact about the database, and keeping it out means this
 * function stays pure and the redemption stays atomic.
 */
export function decodeBindToken(
  token: string,
  secret: string,
  now: Date = new Date(),
): BindTokenPayload | null {
  const bodyLength = USER_CHARS + EXPIRY_CHARS + NONCE_CHARS;
  // Exact length, not a minimum: every field is fixed-width, so anything else
  // is not one of our tokens and there is nothing to be gained by guessing
  // which field went wrong.
  if (token.length !== bodyLength + 22) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return null;

  const body = token.slice(0, bodyLength);
  const provided = Buffer.from(token.slice(bodyLength), 'base64url');
  const expected = sign(secret, body);
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;

  // Verified before interpreted: the bytes below are known to be ours.
  const userBytes = Buffer.from(body.slice(0, USER_CHARS), 'base64url');
  if (userBytes.length !== 16) return null;
  const expiryBytes = Buffer.from(body.slice(USER_CHARS, USER_CHARS + EXPIRY_CHARS), 'base64url');
  if (expiryBytes.length !== EXPIRY_BYTES) return null;

  const expiresAt = new Date(expiryBytes.readUIntBE(0, EXPIRY_BYTES));
  if (expiresAt.getTime() <= now.getTime()) return null;

  return {
    userId: bytesToUuid(userBytes),
    nonce: body.slice(USER_CHARS + EXPIRY_CHARS),
    expiresAt,
  };
}
