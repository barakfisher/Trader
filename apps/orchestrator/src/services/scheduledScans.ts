/**
 * Agents' scheduled scans (Stage 4, PR 7b; D68-D74).
 *
 * Two halves, joined by a queue:
 *
 * - **The plan** runs on every 15-minute `agent_scans` ask (the local timer or
 *   a CronJob, through `POST /internal/runs`). For each active agent with a
 *   persona it works out which slot is due now (`scanSchedule.ts`), reads that
 *   slot's attempts from `runs`, and puts the next attempt on the queue - or
 *   nothing, which is the usual answer.
 * - **The attempt** runs on the queue's worker, `AGENT_SCAN_CONCURRENCY` at a
 *   time (D73). It claims its own run, asks the AI service to scan, writes the
 *   proposal a `trade` makes (announced as ever), and records the outcome on
 *   the run - which is what the next plan reads.
 *
 * **Retries are decided by the plan, from Postgres, not by the queue (D69).**
 * A failed attempt is retried at least an hour later, at most twice, and only
 * inside the slot's window; every other outcome is the slot's answer. Keeping
 * that state in `runs` rather than in Redis means a restart, a cleared queue or
 * a second process can neither repeat an attempt nor lose one: the attempt's
 * run key is unique, and the queue's job id is the same key.
 *
 * **Nothing runs unless the installation schedules (D71)**; the ask returns
 * "skipped" with the reason. *Run a scan now* is the route's, not this.
 */

import { AiServiceError, type AiClient } from '@traders/shared/ai';
import type { ScanSchedule } from '@traders/shared';

import {
  claimRun,
  finishRun,
  getAgent,
  getOrCreateUserSettings,
  listAgents,
  listSlotAttempts,
  type SlotAttemptRow,
} from '../db/queries.js';
import { logger } from '../logger.js';
import { messagesFor } from '../notify/messages.js';
import type { Notifier } from '../notify/notifier.js';
import { dueSlots, slotKey, type DueSlot, type ScanSlot, type Session } from './scanSchedule.js';
import { proposeFromScan } from './tradeProposals.js';

/** D69: one attempt and at most two retries per slot. */
export const MAX_SLOT_ATTEMPTS = 3;
/** D69: a failed attempt is retried no sooner than this. */
export const RETRY_AFTER_MS = 60 * 60 * 1000;
/** Every US listing trades on the XNYS calendar; the AI service maps this exchange to it. */
export const SCHEDULE_EXCHANGE = 'NMS';
/** Sessions read either side of today, so a post-close slot past midnight UTC is found. */
const SESSION_MARGIN_MS = 2 * 24 * 60 * 60 * 1000;

/** Why an attempt failed, in words the give-up message can say (D74). */
export type FailureCause =
  | 'rate_limited'
  | 'provider_error'
  | 'timeout'
  | 'agent_busy'
  | 'no_model'
  | 'scan_failed'
  | 'window_closed';

/** What the queue carries for one attempt. */
export interface SlotAttemptJob {
  userId: string;
  agentId: string;
  day: string;
  slot: ScanSlot;
  attempt: number;
  /** The slot's window end, ISO: an attempt that starts after it is not made. */
  until: string;
}

/** The queue as the plan sees it: one add, keyed, so a repeat add is a no-op. */
export interface ScanQueue {
  add(jobId: string, job: SlotAttemptJob): Promise<void>;
}

export function attemptRunKey(job: Pick<SlotAttemptJob, 'agentId' | 'day' | 'slot' | 'attempt'>): string {
  return `${slotKey(job.agentId, job)}:${job.attempt}`;
}

/**
 * The next attempt a slot should make now, or null (D69). Pure.
 *
 * - None yet: the first.
 * - One running: wait for it.
 * - The last finished in any way but a retryable failure: that is the answer.
 * - A retryable failure: the next, once an hour has passed, while attempts
 *   remain and the window is open.
 */
export function nextAttempt(history: SlotAttemptRow[], slot: Pick<DueSlot, 'until'>, now: Date): number | null {
  if (now.getTime() >= slot.until.getTime()) return null;
  const last = history.at(-1);
  if (last === undefined) return 1;
  if (last.status === 'running') return null;
  if (last.status !== 'failed' || last.stats.retryable !== true) return null;
  if (history.length >= MAX_SLOT_ATTEMPTS) return null;
  const finished = last.finished_at?.getTime() ?? now.getTime();
  return now.getTime() - finished >= RETRY_AFTER_MS ? history.length + 1 : null;
}

export interface PlanResult {
  agents: number;
  due: number;
  enqueued: number;
}

const isoDay = (time: number) => new Date(time).toISOString().slice(0, 10);

/** One 15-minute ask: put every due attempt on the queue. */
export async function planScheduledScans(input: {
  userId: string;
  ai: AiClient;
  queue: ScanQueue;
  now: Date;
  requestId?: string;
}): Promise<PlanResult> {
  const agents = (await listAgents(input.userId)).filter(
    (agent) => !agent.is_primary && agent.state === 'active' && agent.persona?.trim(),
  );
  if (agents.length === 0) return { agents: 0, due: 0, enqueued: 0 };

  const t = input.now.getTime();
  const { sessions } = await input.ai.marketSessions(
    SCHEDULE_EXCHANGE,
    isoDay(t - SESSION_MARGIN_MS),
    isoDay(t + SESSION_MARGIN_MS),
    input.requestId,
  );

  const result: PlanResult = { agents: agents.length, due: 0, enqueued: 0 };
  for (const agent of agents) {
    for (const slot of dueSlots(agent.scan_schedule as ScanSchedule, sessions as Session[], input.now)) {
      result.due += 1;
      const key = slotKey(agent.id, slot);
      const attempt = nextAttempt(await listSlotAttempts(agent.id, key), slot, input.now);
      if (attempt === null) continue;
      const job: SlotAttemptJob = {
        userId: input.userId,
        agentId: agent.id,
        day: slot.day,
        slot: slot.slot,
        attempt,
        until: slot.until.toISOString(),
      };
      await input.queue.add(attemptRunKey(job), job);
      result.enqueued += 1;
    }
  }
  return result;
}

/** How an AI service refusal reads, and whether trying again could help. */
function failureOf(error: unknown): { cause: FailureCause; retryable: boolean; detail: string } {
  if (error instanceof AiServiceError) {
    const code = (error.body as { detail?: { code?: string } } | undefined)?.detail?.code;
    if (error.status === 409 && code === 'scan_running') return { cause: 'agent_busy', retryable: true, detail: code };
    if (error.status === 503 && code === 'no_model') return { cause: 'no_model', retryable: false, detail: code };
    if (error.status === 429) return { cause: 'rate_limited', retryable: true, detail: error.message };
    if (error.status === 504 || error.status === 0) return { cause: 'timeout', retryable: true, detail: error.message };
    return { cause: 'provider_error', retryable: true, detail: `${error.status}: ${error.message}` };
  }
  const message = (error as Error)?.message ?? String(error);
  return { cause: /timeout|aborted/i.test(message) ? 'timeout' : 'provider_error', retryable: true, detail: message };
}

/** Refusals that are the slot's answer, not a failure: nothing to retry, nothing to report. */
const FINAL_REFUSALS = new Set(['budget_spent', 'agent_not_active', 'no_persona', 'primary_agent']);

export interface AttemptDeps {
  ai: AiClient;
  notifier: Notifier;
  now?: () => Date;
}

/**
 * One attempt, on the worker. Never throws: the run records what happened, and
 * a thrown job would only make the queue retry what the plan already decides.
 */
export async function runSlotAttempt(job: SlotAttemptJob, deps: AttemptDeps): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const runKey = attemptRunKey(job);
  const claim = await claimRun({ userId: job.userId, agentId: job.agentId, kind: 'agent_scan', runKey, trigger: 'schedule' });
  if (!claim.claimed) return;
  const runId = claim.runId as string;

  if (now.getTime() >= Date.parse(job.until)) {
    // Queued in time, reached too late: the window belongs to the next scan.
    await finishRun(runId, 'skipped', { reason: 'window_closed' });
    if (job.attempt > 1) await reportGaveUp(job, 'window_closed', deps.notifier);
    return;
  }
  const agent = await getAgent(job.userId, job.agentId);
  if (!agent || agent.state !== 'active' || !agent.persona?.trim()) {
    await finishRun(runId, 'skipped', { reason: 'agent_not_scannable' });
    return;
  }

  try {
    const scan = await deps.ai.scanAgent(agent.id, { user_id: job.userId, trigger: 'schedule' });
    const proposalId = await proposeFromScan(job.userId, agent, scan, { ai: deps.ai, notifier: deps.notifier });
    const stats = { outcome: scan.outcome, scanId: scan.scan_id, proposalId, costMicroUsd: scan.cost_micro_usd };
    if (scan.outcome === 'failed') {
      // The scan ran and the model call failed: the provider's trouble, worth another try.
      const cause: FailureCause = /429|rate.?limit/i.test(scan.error ?? '') ? 'rate_limited' : 'scan_failed';
      await finish(runId, job, { ...stats, cause, retryable: true, error: scan.error }, deps.notifier, now);
      return;
    }
    // Everything else is the slot's answer - a refused answer and a spent budget too (D69).
    await finishRun(runId, scan.outcome === 'budget_reached' ? 'degraded' : 'ok', stats);
  } catch (error) {
    const code = (error instanceof AiServiceError
      ? (error.body as { detail?: { code?: string } } | undefined)?.detail?.code
      : undefined) as string | undefined;
    if (error instanceof AiServiceError && error.status === 409 && code && FINAL_REFUSALS.has(code)) {
      await finishRun(runId, 'skipped', { reason: code });
      return;
    }
    const failure = failureOf(error);
    logger().warn({ runKey, cause: failure.cause, err: error }, 'scheduled_scan.attempt_failed');
    await finish(runId, job, { cause: failure.cause, retryable: failure.retryable, error: failure.detail }, deps.notifier, now);
  }
}

/** A failed attempt: recorded, and reported if it was the slot's last (D74). */
async function finish(
  runId: string,
  job: SlotAttemptJob,
  stats: { cause: FailureCause; retryable: boolean } & Record<string, unknown>,
  notifier: Notifier,
  now: Date,
): Promise<void> {
  await finishRun(runId, 'failed', stats);
  const nextTry = now.getTime() + RETRY_AFTER_MS;
  const last = !stats.retryable || job.attempt >= MAX_SLOT_ATTEMPTS || nextTry >= Date.parse(job.until);
  if (last) await reportGaveUp(job, stats.cause, notifier);
}

/**
 * D74: one message when a slot gives up, naming the agent, the slot and why.
 * A retry that later succeeds sends nothing, because this runs only on the
 * last attempt. The failed run on the Admin page's runs list is the record.
 */
async function reportGaveUp(job: SlotAttemptJob, cause: FailureCause, notifier: Notifier): Promise<void> {
  try {
    const [agent, settings] = await Promise.all([
      getAgent(job.userId, job.agentId),
      getOrCreateUserSettings(job.userId),
    ]);
    const messages = messagesFor(settings.language);
    const text = messages.scheduledScans.gaveUp(
      agent?.name ?? job.agentId,
      messages.scheduledScans.slots[job.slot],
      job.day,
      messages.scheduledScans.causes[cause],
    );
    const delivery = await notifier.send({
      userId: job.userId,
      title: text.headline,
      body: text.explanation,
      severity: 'high',
      language: settings.language,
    });
    logger().warn({ ...job, cause, delivered: delivery.delivered }, 'scheduled_scan.gave_up');
  } catch (error) {
    logger().error({ err: error, ...job }, 'scheduled_scan.report_failed');
  }
}
