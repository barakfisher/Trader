/**
 * D71: whether this installation schedules an agent's scans, and the next
 * one's time. Shared by the agent's page and the Telegram agent view, which
 * must name the same next scan.
 */

import type { AgentScheduling } from '@traders/shared';
import type { AiClient } from '@traders/shared/ai';

import type { AgentRow } from '../db/queries.js';
import { logger } from '../logger.js';
import { readyToScan } from './agentReadiness.js';
import { nextSlot, scheduleOf, type Session } from './scanSchedule.js';
import { SCHEDULE_EXCHANGE } from './scheduledScans.js';

/** A week of sessions ahead holds the next slot even across a long weekend. */
const NEXT_SLOT_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A calendar the AI service cannot answer leaves the time out rather than
 * failing the caller.
 */
export async function schedulingOf(
  row: AgentRow,
  enabled: boolean,
  ai: AiClient,
  requestId?: string,
): Promise<AgentScheduling> {
  if (!enabled || row.state !== 'active' || !readyToScan(row)) return { enabled, nextAt: null };
  const now = new Date();
  try {
    const { sessions } = await ai.marketSessions(
      SCHEDULE_EXCHANGE,
      now.toISOString().slice(0, 10),
      new Date(now.getTime() + NEXT_SLOT_HORIZON_MS).toISOString().slice(0, 10),
      requestId,
    );
    const next = nextSlot(scheduleOf(row), sessions as Session[], now);
    return { enabled, nextAt: next?.at.toISOString() ?? null };
  } catch (error) {
    logger().warn({ err: error, agentId: row.id }, 'agents.next_scan_unknown');
    return { enabled, nextAt: null };
  }
}
