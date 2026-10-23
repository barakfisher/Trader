/**
 * Pausing, resuming and rescheduling a simulated agent, and the limits a resume
 * meets (D199, D201, D202). The agent page's `PATCH /agents/:id` and the
 * Telegram agent controls (M11 A2) both come through here, so a tap and a click
 * meet the same refusals in the same words (D276).
 */

import { MAX_AGENTS_PER_USER_CEILING, type ScanSchedule } from '@traders/shared';

import {
  countActiveAgents,
  countLiveAgents,
  getAgent,
  getInstallationSettings,
  updateAgent,
  type AgentRow,
  type UserRow,
} from '../db/queries.js';
import { conflict, notFound } from '../http/errors.js';

/** Postgres's code for a CHECK refusal, which the agents' triggers raise (0062, 0063). */
export const CHECK_VIOLATION = '23514';

/** The database's own refusals (migrations 0062, 0063), met when a racing write got there first. */
function isRefusal(error: unknown, code: 'agent_limit_reached' | 'agent_total_reached'): boolean {
  const pg = error as { code?: string; message?: string };
  return pg.code === CHECK_VIOLATION && (pg.message ?? '').startsWith(code);
}

export function agentLimitReached(max: number) {
  return conflict(
    'agent_limit_reached',
    `you have ${max} active agents, the most this installation allows: pause one to make room`,
    { max },
  );
}

export function agentTotalReached() {
  return conflict(
    'agent_total_reached',
    `you have ${MAX_AGENTS_PER_USER_CEILING} agents, the most anyone may keep: archive one to make room`,
    { max: MAX_AGENTS_PER_USER_CEILING },
  );
}

/** D201: the admin has no limit; anyone else has the installation's. */
export async function activeLimitFor(user: Pick<UserRow, 'role'> | undefined | null): Promise<number | null> {
  if (user?.role === 'admin') return null;
  return (await getInstallationSettings()).max_agents_per_user;
}

/**
 * Refuse before writing when one more active agent would pass the limit (D199):
 * a create as active, a resume, a restore into active. Paused never counts.
 */
export async function assertRoomToActivate(userId: string, user: Pick<UserRow, 'role'> | undefined | null): Promise<void> {
  const [max, used] = await Promise.all([activeLimitFor(user), countActiveAgents(userId)]);
  if (max !== null && used >= max) throw agentLimitReached(max);
}

/**
 * Refuse before writing when one more agent that is not archived would pass the
 * fixed ceiling (D202): a create in any state, a restore. The admin has none (D201).
 */
export async function assertRoomToKeep(userId: string, user: Pick<UserRow, 'role'> | undefined | null): Promise<void> {
  if (user?.role === 'admin') return;
  if ((await countLiveAgents(userId)) >= MAX_AGENTS_PER_USER_CEILING) throw agentTotalReached();
}

/** A write the database refused for a limit, as the refusal the check before it would have given. */
export async function limitAfter(error: unknown): Promise<never> {
  if (isRefusal(error, 'agent_total_reached')) throw agentTotalReached();
  if (isRefusal(error, 'agent_limit_reached')) {
    throw agentLimitReached((await getInstallationSettings()).max_agents_per_user);
  }
  throw error;
}

/** The agent, if it is one that can be paused or rescheduled: the user's, simulated, not archived. */
async function controllable(userId: string, agentId: string): Promise<AgentRow> {
  const agent = await getAgent(userId, agentId);
  if (!agent || agent.state === 'archived') throw notFound('agent not found');
  if (agent.is_primary) {
    throw conflict('primary_agent_is_passive', 'the real portfolio has no pause or schedule');
  }
  return agent;
}

/** Pause or resume. A resume takes a place under the active limit (D199); a pause never does. */
export async function setAgentRunning(
  user: Pick<UserRow, 'id' | 'role'>,
  agentId: string,
  state: 'active' | 'paused',
): Promise<AgentRow> {
  const agent = await controllable(user.id, agentId);
  if (agent.state === state) return agent;
  if (state === 'active') await assertRoomToActivate(user.id, user);
  try {
    const row = await updateAgent(user.id, agentId, { state }, { unlessArchived: true });
    if (!row) throw notFound('agent not found');
    return row;
  } catch (error) {
    return limitAfter(error);
  }
}

/** Replace when the agent's scheduled scans run (D195). */
export async function setAgentSchedule(userId: string, agentId: string, schedule: ScanSchedule): Promise<AgentRow> {
  await controllable(userId, agentId);
  const row = await updateAgent(userId, agentId, { scanSchedule: schedule }, { unlessArchived: true });
  if (!row) throw notFound('agent not found');
  return row;
}
