/**
 * The `callback_data` of the bot's menu buttons (M11 slice A1, D269): which
 * view to show, or which quick mute to set.
 *
 * **Unsigned, on purpose.** A proposal button names a proposal and decides it,
 * so it carries an HMAC and a nonce (`callbackToken.ts`). A menu button decides
 * nothing that is not the tapper's own: every view is read for the user the
 * *tapping* chat is bound to, and an agent id is looked up under that user, so
 * an edited or forwarded button can show its holder their own data and nothing
 * else. A signature would prove only that we wrote the button, which grants
 * nothing here. Buttons that spend money or change an agent (slice A2) are
 * signed, as proposal buttons are.
 *
 * Format: `m:` then one letter, then an agent id (22 base64url characters of
 * its 16 bytes) or a mute's hours. `:` is not in base64url, so no signed
 * payload starts this way, and `busy` does not either.
 */

import { bytesToUuid, UUID_CHARS, uuidToBytes } from './callbackBytes.js';

export const MENU_PREFIX = 'm:';

/** The quick mutes the status view offers, in hours. */
export const QUICK_MUTE_HOURS = [1, 4] as const;

export type MenuView =
  | { view: 'help' }
  | { view: 'portfolio' }
  | { view: 'agents' }
  | { view: 'status' }
  | { view: 'pending' }
  | { view: 'agent'; agentId: string }
  | { view: 'agentLog'; agentId: string }
  /** M11 A2: the confirm before a paid scan, and the schedule picker. Views, so unsigned. */
  | { view: 'runConfirm'; agentId: string }
  | { view: 'schedule'; agentId: string }
  /** M11 B: one open proposal from `/pending`, with its own signed buttons (D279). */
  | { view: 'proposal'; proposalId: string };

type AgentView = Extract<MenuView, { agentId: string }>['view'];

/** A tap: a view to show, or a quick mute (`hours: 0` unmutes) followed by the status view. */
export type MenuTap = MenuView | { view: 'mute'; hours: 0 | (typeof QUICK_MUTE_HOURS)[number] };

const PLAIN_CODES = { help: 'h', portfolio: 'p', agents: 'a', status: 's', pending: 'q' } as const;
const AGENT_CODES: Record<AgentView, string> = { agent: 'g', agentLog: 'l', runConfirm: 'r', schedule: 'c' };
const MUTE_CODE = 'u';
const PROPOSAL_CODE = 'o';

const PLAIN_BY_CODE = new Map<string, string>(Object.entries(PLAIN_CODES).map(([view, code]) => [code, view]));
const AGENT_BY_CODE = new Map<string, string>(Object.entries(AGENT_CODES).map(([view, code]) => [code, view]));

export function isMenuData(data: string): boolean {
  return data.startsWith(MENU_PREFIX);
}

export function encodeMenuData(tap: MenuTap): string {
  switch (tap.view) {
    case 'agent':
    case 'agentLog':
    case 'runConfirm':
    case 'schedule':
      return `${MENU_PREFIX}${AGENT_CODES[tap.view]}${uuidToBytes(tap.agentId).toString('base64url')}`;
    case 'mute':
      return `${MENU_PREFIX}${MUTE_CODE}${tap.hours}`;
    case 'proposal':
      return `${MENU_PREFIX}${PROPOSAL_CODE}${uuidToBytes(tap.proposalId).toString('base64url')}`;
    default:
      return `${MENU_PREFIX}${PLAIN_CODES[tap.view]}`;
  }
}

/** A UUID from its 22 base64url characters; null for anything else. */
function idOf(rest: string): string | null {
  if (rest.length !== UUID_CHARS) return null;
  const bytes = Buffer.from(rest, 'base64url');
  // Re-encoding must give back the same text: rejects characters base64url ignores.
  if (bytes.length !== 16 || bytes.toString('base64url') !== rest) return null;
  return bytesToUuid(bytes);
}

/** The tap a button names; null for anything this module would not have written. */
export function decodeMenuData(data: string): MenuTap | null {
  if (!isMenuData(data)) return null;
  const code = data.slice(MENU_PREFIX.length, MENU_PREFIX.length + 1);
  const rest = data.slice(MENU_PREFIX.length + 1);

  const plain = PLAIN_BY_CODE.get(code);
  if (plain !== undefined) return rest === '' ? ({ view: plain } as MenuView) : null;

  const agentView = AGENT_BY_CODE.get(code);
  if (agentView !== undefined) {
    const id = idOf(rest);
    return id === null ? null : { view: agentView as AgentView, agentId: id };
  }

  if (code === PROPOSAL_CODE) {
    const id = idOf(rest);
    return id === null ? null : { view: 'proposal', proposalId: id };
  }

  if (code === MUTE_CODE) {
    const hours = Number(rest);
    if (rest === '0') return { view: 'mute', hours: 0 };
    return (QUICK_MUTE_HOURS as readonly number[]).includes(hours) && String(hours) === rest
      ? { view: 'mute', hours: hours as (typeof QUICK_MUTE_HOURS)[number] }
      : null;
  }
  return null;
}
