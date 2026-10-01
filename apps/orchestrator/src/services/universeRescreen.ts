/**
 * Start a universe rescreen: the one path behind the admin's button and the
 * quarterly CronJob (decision 90, after the plan's decisions 3-4).
 *
 * Both claim the same run key, `universe-rescreen:<date>` in the installation's
 * timezone, so a click and a CronJob the same day are one run - the plan's
 * `<quarter>` for the CronJob could never have been "the same single run" as a
 * click. The run belongs to no account (`user_id` null): the universe is the
 * installation's.
 *
 * This only claims and hands over. The AI service builds the snapshot in the
 * background, heartbeats while it works, and finishes the run row itself; a
 * rescreen takes half an hour or more once Yahoo rate-limits it, and no
 * request waits that long.
 */

import type { AiClient } from '@traders/shared/ai';

import { claimRun, finishRun } from '../db/queries.js';
import { logger } from '../logger.js';
import { localDate } from './snapshot.js';

export const RESCREEN_KIND = 'universe_rescreen';

export type RescreenStart =
  /** Claimed and handed to the AI service, which is building now. */
  | { status: 'running'; runId: string; runKey: string }
  /** Not started: already claimed today, another rescreen running, or this installation cannot. */
  | { status: 'skipped'; runId: string | null; runKey: string; reason: string };

export function rescreenRunKey(timezone: string, now: Date = new Date()): string {
  return `universe-rescreen:${localDate(timezone, now)}`;
}

export async function startRescreen(
  ai: Pick<AiClient, 'rescreen'>,
  options: { timezone: string; trigger: string; requestId?: string; runKey?: string; now?: Date },
): Promise<RescreenStart> {
  const runKey = options.runKey ?? rescreenRunKey(options.timezone, options.now);
  // A failed rescreen may be retried the same day: its fetch cache is kept in
  // the volume, so the retry asks Yahoo only for what failed (rate limits are
  // the usual cause, measured on the first real run).
  const claim = await claimRun({
    userId: null,
    kind: RESCREEN_KIND,
    runKey,
    trigger: options.trigger,
    retryFailed: true,
  });
  if (!claim.claimed) {
    return {
      status: 'skipped',
      runId: null,
      runKey,
      reason: `this run key was already claimed (${claim.existingStatus ?? 'unknown'})`,
    };
  }
  const runId = claim.runId as string;
  let answer;
  try {
    answer = await ai.rescreen(runId, options.requestId);
  } catch (error) {
    // Nothing is building, so the run must not stay claimed until it goes stale.
    await finishRun(runId, 'failed', { error: (error as Error).message });
    throw error;
  }
  if (answer.status === 'started' || answer.status === 'in_progress') {
    return { status: 'running', runId, runKey };
  }
  const reason =
    answer.status === 'unavailable'
      ? (answer.reason ?? 'this installation cannot rescreen')
      : 'the AI service did not find the run it was handed';
  // A configuration, not a failure: an installation without a snapshot volume
  // asked to rescreen has run, found it cannot, and says why.
  await finishRun(runId, 'skipped', { reason });
  logger().warn({ runKey, reason }, 'rescreen not started');
  return { status: 'skipped', runId, runKey, reason };
}
