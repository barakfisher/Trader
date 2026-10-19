/**
 * The compact spellings signed Telegram buttons are made of (`callbackToken.ts`,
 * `signupToken.ts`). Telegram allows 64 bytes of `callback_data`, so a UUID
 * travels as its 16 raw bytes and a number as a varint, both in base64url.
 */

/**
 * A UUID as its 16 raw bytes rather than its 36-character spelling.
 *
 * This single choice is most of the byte budget: base64url of 16 bytes is 22
 * characters against the 36 a hyphenated UUID costs.
 */
export function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== 32 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new Error(`not a uuid: ${uuid}`);
  }
  return Buffer.from(hex, 'hex');
}

export function bytesToUuid(buffer: Buffer): string {
  const hex = buffer.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/** base64url of a 16-byte UUID: fixed, so what follows needs no separator. */
export const UUID_CHARS = 22;

/**
 * A positive integer as an unsigned LEB128 varint: seven bits a byte, the high
 * bit set on every byte but the last. $238.68 in minor units is three bytes -
 * four base64url characters - where its decimal spelling would be five and a
 * fixed-width integer eight. `max` bounds it, so the caller's budget holds.
 */
export function uintToBytes(value: bigint, max: bigint): Buffer {
  if (value <= 0n || value > max) {
    throw new Error(`${value} cannot be carried by a callback`);
  }
  const bytes: number[] = [];
  let rest = value;
  while (rest >= 0x80n) {
    bytes.push(Number(rest & 0x7fn) | 0x80);
    rest >>= 7n;
  }
  bytes.push(Number(rest));
  return Buffer.from(bytes);
}

/** The inverse of `uintToBytes`; null for anything it would not have written. */
export function bytesToUint(bytes: Buffer, max: bigint): bigint | null {
  let value = 0n;
  for (const [index, byte] of bytes.entries()) {
    value |= BigInt(byte & 0x7f) << BigInt(7 * index);
    const last = index === bytes.length - 1;
    if (last !== ((byte & 0x80) === 0)) return null;
  }
  return value > 0n && value <= max ? value : null;
}
