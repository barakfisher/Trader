/**
 * The signed buttons under a proposal the assistant drafted in Telegram (D393).
 *
 * Whose draft it is comes from the chat's binding, and the message is looked up
 * under that user, so a forwarded button finds nothing. The signature keeps an
 * edited button from naming another message or the other action.
 *
 * **No nonce.** Both taps are idempotent: the draft's own state answers a second
 * one, and its deadline is on the server, not in the button.
 *
 * Format: `<message><action>.<mac>`, at most 46 bytes.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { bytesToUuid, UUID_CHARS, uuidToBytes } from './callbackBytes.js';
import { MAX_CALLBACK_DATA_BYTES } from './callbackToken.js';

const MAC_BYTES = 16;
const DOMAIN = 'telegram-assistant-draft-v1';

const ACTION_CODES = { add: 'a', close: 'c' } as const;

export type AssistantDraftAction = keyof typeof ACTION_CODES;

export interface AssistantDraftPayload {
  messageId: string;
  action: AssistantDraftAction;
}

function sign(secret: string, body: string): Buffer {
  return createHmac('sha256', secret).update(`${DOMAIN}:${body}`).digest().subarray(0, MAC_BYTES);
}

export function encodeAssistantDraftData(payload: AssistantDraftPayload, secret: string): string {
  const body = `${uuidToBytes(payload.messageId).toString('base64url')}${ACTION_CODES[payload.action]}`;
  const data = `${body}.${sign(secret, body).toString('base64url')}`;
  if (Buffer.byteLength(data, 'utf8') > MAX_CALLBACK_DATA_BYTES) {
    throw new Error(`callback_data is ${Buffer.byteLength(data, 'utf8')} bytes, over Telegram's ${MAX_CALLBACK_DATA_BYTES}`);
  }
  return data;
}

/** Null for anything this module did not sign. */
export function decodeAssistantDraftData(data: string, secret: string): AssistantDraftPayload | null {
  const separator = data.lastIndexOf('.');
  if (separator <= 0) return null;
  const body = data.slice(0, separator);
  const provided = Buffer.from(data.slice(separator + 1), 'base64url');
  const expected = sign(secret, body);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  const messageBytes = Buffer.from(body.slice(0, UUID_CHARS), 'base64url');
  if (messageBytes.length !== 16) return null;
  const code = body.slice(UUID_CHARS);
  const action = code === ACTION_CODES.add ? 'add' : code === ACTION_CODES.close ? 'close' : null;
  return action === null ? null : { messageId: bytesToUuid(messageBytes), action };
}
