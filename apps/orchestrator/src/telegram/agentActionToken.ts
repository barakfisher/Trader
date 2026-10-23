/**
 * Signed buttons that change an agent or spend on it from Telegram (M11 A2, D274):
 * Run the scan (after a confirm that names its cost), Pause, Resume, and a new
 * schedule.
 *
 * **Why signed, when the menu's buttons are not (D269).** Whose agent it is
 * comes from the chat's binding, as for the menu. What the signature adds is
 * the moment the button was drawn: these buttons expire
 * (`AGENT_ACTION_TTL_MINUTES`), so a Run confirmed in a message read an hour
 * ago - at an older cost, perhaps on a since-paused agent - is refused and
 * redrawn rather than obeyed, and an edited button cannot move its own clock.
 *
 * **No nonce.** A proposal button burns one because Approve-Undo-Approve are
 * all legitimate taps on one proposal, and the burn rides a write the decision
 * makes anyway. Here, Pause, Resume and a schedule are idempotent - the second
 * tap sets what the first set. A second Run within the window is stopped by
 * what stops it on the web: one running scan per agent (`agent_scans_one_running`),
 * the `agentScan` rate limit (D257), and the confirm being edited away the
 * moment it is tapped.
 *
 * Format: `<agent><action>[<schedule>]<minute>.<mac>` - the agent's 16 bytes
 * and the MAC's 16 in base64url, one letter for the action, one character for
 * a schedule, and the minute it was drawn as a varint. At most 53 bytes.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { MAX_SCAN_EVERY_HOURS, MIN_SCAN_EVERY_HOURS, type ScanSchedule } from '@traders/shared';

import { bytesToUint, bytesToUuid, UUID_CHARS, uintToBytes, uuidToBytes } from './callbackBytes.js';
import { MAX_CALLBACK_DATA_BYTES } from './callbackToken.js';

const MAC_BYTES = 16;
const DOMAIN = 'telegram-agent-v1';

/** How long a drawn agent button may be used. A Refresh draws them again. */
export const AGENT_ACTION_TTL_MINUTES = 15;

/** A clock running a little ahead of ours is still believed, by this much. */
const CLOCK_SKEW_MINUTES = 1;

const ACTION_CODES = { run: 'r', pause: 'p', resume: 'a', schedule: 's' } as const;

export type AgentAction = keyof typeof ACTION_CODES;

const ACTIONS_BY_CODE = new Map<string, AgentAction>(
  Object.entries(ACTION_CODES).map(([action, code]) => [code, action as AgentAction]),
);

export type AgentActionPayload =
  | { agentId: string; action: 'run' | 'pause' | 'resume' }
  | { agentId: string; action: 'schedule'; schedule: ScanSchedule };

/** Minutes since the epoch: a varint of four bytes until the year 2225. */
const MINUTE_WIRE_MAX = (1n << 32n) - 1n;

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * A schedule in one character: the hours between market-hours scans (0 for
 * none, else 1-6) times four, plus pre-open and post-close as two bits.
 */
export function scheduleToChar(schedule: ScanSchedule): string {
  const hours = schedule.everyHours ?? 0;
  if (hours !== 0 && (hours < MIN_SCAN_EVERY_HOURS || hours > MAX_SCAN_EVERY_HOURS || !Number.isInteger(hours))) {
    throw new Error(`no button carries a schedule every ${hours}h`);
  }
  return BASE64URL[hours * 4 + (schedule.preOpen ? 2 : 0) + (schedule.postClose ? 1 : 0)]!;
}

export function charToSchedule(char: string): ScanSchedule | null {
  const index = BASE64URL.indexOf(char);
  if (char.length !== 1 || index < 0) return null;
  const hours = index >> 2;
  if (hours !== 0 && (hours < MIN_SCAN_EVERY_HOURS || hours > MAX_SCAN_EVERY_HOURS)) return null;
  return { everyHours: hours === 0 ? null : hours, preOpen: (index & 2) !== 0, postClose: (index & 1) !== 0 };
}

function sign(secret: string, body: string): Buffer {
  return createHmac('sha256', secret).update(`${DOMAIN}:${body}`).digest().subarray(0, MAC_BYTES);
}

const minuteOf = (now: Date): bigint => BigInt(Math.floor(now.getTime() / 60_000));

export function encodeAgentActionData(payload: AgentActionPayload, secret: string, now = new Date()): string {
  const schedule = payload.action === 'schedule' ? scheduleToChar(payload.schedule) : '';
  const minute = uintToBytes(minuteOf(now), MINUTE_WIRE_MAX).toString('base64url');
  const body = `${uuidToBytes(payload.agentId).toString('base64url')}${ACTION_CODES[payload.action]}${schedule}${minute}`;
  const data = `${body}.${sign(secret, body).toString('base64url')}`;
  if (Buffer.byteLength(data, 'utf8') > MAX_CALLBACK_DATA_BYTES) {
    throw new Error(`callback_data is ${Buffer.byteLength(data, 'utf8')} bytes, over Telegram's ${MAX_CALLBACK_DATA_BYTES}`);
  }
  return data;
}

export type DecodedAgentAction = { payload: AgentActionPayload; expired: boolean };

/**
 * Verify, then interpret. Null for anything this module did not sign; a signed
 * button past its time is returned with `expired`, so the tap can be answered
 * with a fresh view rather than a bare refusal.
 */
export function decodeAgentActionData(data: string, secret: string, now = new Date()): DecodedAgentAction | null {
  const separator = data.lastIndexOf('.');
  if (separator <= 0) return null;
  const body = data.slice(0, separator);
  const provided = Buffer.from(data.slice(separator + 1), 'base64url');
  const expected = sign(secret, body);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

  const agentBytes = Buffer.from(body.slice(0, UUID_CHARS), 'base64url');
  if (agentBytes.length !== 16) return null;
  const action = ACTIONS_BY_CODE.get(body.slice(UUID_CHARS, UUID_CHARS + 1));
  if (action === undefined) return null;
  let rest = body.slice(UUID_CHARS + 1);
  const agentId = bytesToUuid(agentBytes);

  let payload: AgentActionPayload;
  if (action === 'schedule') {
    const schedule = charToSchedule(rest.slice(0, 1));
    if (schedule === null) return null;
    rest = rest.slice(1);
    payload = { agentId, action, schedule };
  } else {
    payload = { agentId, action };
  }
  const minute = rest === '' ? null : bytesToUint(Buffer.from(rest, 'base64url'), MINUTE_WIRE_MAX);
  if (minute === null) return null;
  const age = minuteOf(now) - minute;
  return { payload, expired: age > BigInt(AGENT_ACTION_TTL_MINUTES) || age < -BigInt(CLOCK_SKEW_MINUTES) };
}
