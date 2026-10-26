/**
 * The daily research on the main portfolio (D254, D290).
 *
 * **When:** once a New York trading day, in the window after the close - the
 * same `post_close` slot an agent's scans may take, from fifteen minutes after
 * the close to midnight New York (`scanSchedule.ts`). Research reads the day's
 * closes and news, so after the close is when there is a day to read.
 *
 * **How it is triggered:** inside the 15-minute `agent_scans` ask
 * (`scheduledScans.ts`), as another kind of attempt on the same queue - not a
 * run kind of its own with its own CronJob. The plan already reads the
 * calendar, the active users and the attempts in Postgres, and retries a
 * failure an hour later inside the window (D69); research needs exactly that.
 * Each attempt is a `runs` row of kind `research` (0070) keyed
 * `research:<agent>:<day>:<n>`, so a repeated ask or a restart never starts a
 * day's research twice. Nothing runs unless the installation schedules (D71).
 *
 * **What an attempt does:** asks the AI service to start the run, which
 * answers at once (202) and rates the holdings in the background. The attempt's
 * outcome is whether the run started; the ratings' are the run's own row.
 */

import { LEGAL_VERSION, PAYER_REFUSALS, RESEARCH_REFUSALS } from '@traders/shared';
import { AiServiceError, type AiClient } from '@traders/shared/ai';

import { claimRun, finishRun, getUser, hasAcceptedLegalVersion, listSlotAttempts, type ResearchAssignmentRow } from '../db/queries.js';
import { logger } from '../logger.js';
import { dueSlots, type DueSlot, type Session } from './scanSchedule.js';
import type { SlotAttemptJob } from './scheduledScans.js';

/** The research's one slot a day: after the close (D290). */
export const RESEARCH_SCHEDULE = { everyHours: null, preOpen: false, postClose: true } as const;

/** One day's research identity: the prefix of each attempt's run key. */
export function researchSlotKey(agentId: string, day: string): string {
  return `research:${agentId}:${day}`;
}

export function researchRunKey(job: Pick<SlotAttemptJob, 'agentId' | 'day' | 'attempt'>): string {
  return `${researchSlotKey(job.agentId, job.day)}:${job.attempt}`;
}

/**
 * The research attempts due now, per user, for the plan to interleave with the
 * scans. `assignments` are the users whose assigned agent is active. `nextAttempt` is the scans' own rule (D69).
 */
export async function planResearch(input: {
  assignments: ResearchAssignmentRow[];
  sessions: Session[];
  now: Date;
  nextAttempt: (history: Awaited<ReturnType<typeof listSlotAttempts>>, slot: Pick<DueSlot, 'until'>, now: Date) => number | null;
}): Promise<{ due: number; jobs: Map<string, SlotAttemptJob[]> }> {
  const jobs = new Map<string, SlotAttemptJob[]>();
  let due = 0;
  for (const assignment of input.assignments) {
    for (const slot of dueSlots(RESEARCH_SCHEDULE, input.sessions, input.now)) {
      due += 1;
      const key = researchSlotKey(assignment.agent_id, slot.day);
      const attempt = input.nextAttempt(await listSlotAttempts(assignment.agent_id, key, 'research'), slot, input.now);
      if (attempt === null) continue;
      const list = jobs.get(assignment.user_id) ?? [];
      list.push({
        kind: 'research',
        userId: assignment.user_id,
        agentId: assignment.agent_id,
        day: slot.day,
        slot: slot.slot,
        attempt,
        until: slot.until.toISOString(),
      });
      jobs.set(assignment.user_id, list);
    }
  }
  return { due, jobs };
}

/** Refusals that are the day's answer: nothing to retry. */
const FINAL_REFUSALS = new Set<string>([...RESEARCH_REFUSALS, ...PAYER_REFUSALS]);

/** One research attempt, on the worker. Never throws: the run records what happened. */
/**
 * Why a queued attempt was skipped: its account was closed (D264) or disabled
 * (D239) after the slot was queued, so it runs nothing more (D316's debt).
 */
export const USER_NOT_ACTIVE = 'user_not_active';

/**
 * Why a queued attempt was skipped: the account has not accepted the current
 * privacy policy and terms (D320), so nothing is done with its data - nor its
 * budget spent - until it does.
 */
export const LEGAL_NOT_ACCEPTED = 'legal_not_accepted';

/**
 * Why a queued attempt for `userId` must not run, or null when it may: the
 * account's status, then its acceptance of `legalVersion` - which the admin,
 * whose installation's terms these are, is never asked for.
 */
export async function accountHold(userId: string, legalVersion: string | null = LEGAL_VERSION): Promise<string | null> {
  const user = await getUser(userId);
  if (user?.status !== 'active') return USER_NOT_ACTIVE;
  if (legalVersion !== null && user.role !== 'admin' && !(await hasAcceptedLegalVersion(userId, legalVersion))) {
    return LEGAL_NOT_ACCEPTED;
  }
  return null;
}

export async function runResearchAttempt(job: SlotAttemptJob, deps: { ai: AiClient; now?: () => Date }): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const runKey = researchRunKey(job);
  const claim = await claimRun({ userId: job.userId, agentId: job.agentId, kind: 'research', runKey, trigger: 'schedule' });
  if (!claim.claimed) return;
  const runId = claim.runId as string;
  if (now.getTime() >= Date.parse(job.until)) {
    await finishRun(runId, 'skipped', { reason: 'window_closed' });
    return;
  }
  const hold = await accountHold(job.userId);
  if (hold !== null) {
    await finishRun(runId, 'skipped', { reason: hold });
    return;
  }
  try {
    const started = await deps.ai.startResearch({ user_id: job.userId, trigger: 'schedule' });
    await finishRun(runId, 'ok', { researchRunId: started.run_id, holdings: started.holdings });
  } catch (error) {
    const code =
      error instanceof AiServiceError
        ? (error.body as { detail?: { code?: string } } | undefined)?.detail?.code
        : undefined;
    if (error instanceof AiServiceError && error.status === 409 && code && FINAL_REFUSALS.has(code)) {
      await finishRun(runId, 'skipped', { reason: code });
      return;
    }
    const detail = error instanceof Error ? error.message : String(error);
    logger().warn({ runKey, err: error }, 'scheduled_research.attempt_failed');
    // A model that is not configured is the installation's answer, not a passing fault.
    const retryable = !(error instanceof AiServiceError && error.status === 503);
    await finishRun(runId, 'failed', { cause: 'research_failed', retryable, error: detail });
  }
}
