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

import { PAYER_REFUSALS, UI_LANGUAGES, type LocalizedTexts } from '@traders/shared';
import { AiServiceError, type AiClient } from '@traders/shared/ai';

import {
  claimRun,
  finishRun,
  getAgent,
  getOrCreateUserSettings,
  getUser,
  listActiveResearchAssignments,
  listAgents,
  listSlotAttempts,
  type SlotAttemptRow,
} from '../db/queries.js';
import { logger } from '../logger.js';
import { messagesFor, type NoticeText } from '../notify/messages.js';
import type { Notifier } from '../notify/notifier.js';
import { fanOut, settingsForNotification } from './notifications.js';
import { dueSlots, scheduleOf, slotKey, type DueSlot, type ScanSlot, type Session } from './scanSchedule.js';
import { accountHold } from './accountHold.js';
import { readyToScan } from './agentReadiness.js';
import { proposeFromScan } from './tradeProposals.js';
import { announceModelFallbacks } from './modelFallbacks.js';
import { reviewAfterScan } from './agentReview.js';
import { planResearch, researchRunKey, runResearchAttempt } from './scheduledResearch.js';

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

/** What the queue carries for one attempt: a scan's, or a day's research (D290). */
export interface SlotAttemptJob {
  /** Absent for a scan, which every job was before research shared the queue. */
  kind?: 'research';
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

export function attemptRunKey(job: Pick<SlotAttemptJob, 'kind' | 'agentId' | 'day' | 'slot' | 'attempt'>): string {
  if (job.kind === 'research') return researchRunKey(job);
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
  /** Active users whose agents were planned (D161). */
  users: number;
  agents: number;
  due: number;
  enqueued: number;
}

const isoDay = (time: number) => new Date(time).toISOString().slice(0, 10);

/**
 * Take one from each list in turn until all are empty: [[a1, a2], [b1]] is
 * [a1, b1, a2]. Pure.
 */
export function roundRobin<T>(lists: T[][]): T[] {
  const out: T[] = [];
  for (let index = 0; lists.some((list) => index < list.length); index += 1) {
    for (const list of lists) if (index < list.length) out.push(list[index] as T);
  }
  return out;
}

/**
 * One 15-minute ask: put every due attempt of every active user on the queue
 * (D161, D238). The queue works through jobs in the order they are added, so
 * the users' attempts are added in turn - one user's ten agents cannot push
 * another's one slot to the back of the line.
 */
export async function planScheduledScans(input: {
  userIds: string[];
  ai: AiClient;
  queue: ScanQueue;
  now: Date;
  requestId?: string;
}): Promise<PlanResult> {
  const perUser = await Promise.all(
    input.userIds.map(async (userId) => ({
      userId,
      agents: (await listAgents(userId)).filter(
        (agent) => !agent.is_primary && agent.state === 'active' && readyToScan(agent),
      ),
    })),
  );
  const agents = perUser.reduce((sum, user) => sum + user.agents.length, 0);
  const result: PlanResult = { users: input.userIds.length, agents, due: 0, enqueued: 0 };
  const researching = await listActiveResearchAssignments(input.userIds);
  if (agents === 0 && researching.length === 0) return result;

  const t = input.now.getTime();
  const { sessions } = await input.ai.marketSessions(
    SCHEDULE_EXCHANGE,
    isoDay(t - SESSION_MARGIN_MS),
    isoDay(t + SESSION_MARGIN_MS),
    input.requestId,
  );

  const jobsPerUser: SlotAttemptJob[][] = [];
  for (const user of perUser) {
    const jobs: SlotAttemptJob[] = [];
    for (const agent of user.agents) {
      for (const slot of dueSlots(scheduleOf(agent), sessions as Session[], input.now)) {
        result.due += 1;
        const key = slotKey(agent.id, slot);
        const attempt = nextAttempt(await listSlotAttempts(agent.id, key), slot, input.now);
        if (attempt === null) continue;
        jobs.push({
          userId: user.userId,
          agentId: agent.id,
          day: slot.day,
          slot: slot.slot,
          attempt,
          until: slot.until.toISOString(),
        });
      }
    }
    jobsPerUser.push(jobs);
  }
  // A day's research is one more of the user's attempts, taken in turn with their scans.
  const research = await planResearch({ assignments: researching, sessions: sessions as Session[], now: input.now, nextAttempt });
  result.due += research.due;
  perUser.forEach((user, index) => jobsPerUser[index]!.push(...(research.jobs.get(user.userId) ?? [])));
  for (const job of roundRobin(jobsPerUser)) {
    await input.queue.add(attemptRunKey(job), job);
    result.enqueued += 1;
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

/**
 * Refusals that are the slot's answer, not a failure: nothing to retry, nothing to
 * report. A user nobody may pay for - no working key of their own, or their safety
 * limit spent - is skipped, not run and failed (D245, D250); the app says why.
 */
const FINAL_REFUSALS = new Set<string>([
  'budget_spent',
  'agent_not_active',
  'no_persona',
  'primary_agent',
  ...PAYER_REFUSALS,
]);

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
  if (job.kind === 'research') return runResearchAttempt(job, deps);
  const now = (deps.now ?? (() => new Date()))();
  const runKey = attemptRunKey(job);
  const claim = await claimRun({ userId: job.userId, agentId: job.agentId, kind: 'agent_scan', runKey, trigger: 'schedule' });
  if (!claim.claimed) return;
  const runId = claim.runId as string;

  if (now.getTime() >= Date.parse(job.until)) {
    // Queued in time, reached too late: the window belongs to the next scan.
    await finishRun(runId, 'skipped', { reason: 'window_closed' });
    if (job.attempt > 1) await reportGaveUp(runId, job, 'window_closed', deps.notifier, now);
    return;
  }
  const agent = await getAgent(job.userId, job.agentId);
  if (!agent || agent.state !== 'active' || !readyToScan(agent)) {
    await finishRun(runId, 'skipped', { reason: 'agent_not_scannable' });
    return;
  }
  // An account closed (D264) or disabled (D239) after the slot was queued runs
  // nothing more (D316), nor one that has not accepted the current terms (D320).
  const hold = await accountHold(job.userId);
  if (hold !== null) {
    await finishRun(runId, 'skipped', { reason: hold });
    return;
  }

  try {
    const scan = await deps.ai.scanAgent(agent.id, { user_id: job.userId, trigger: 'schedule' });
    const proposalIds = await proposeFromScan(job.userId, agent, scan, { ai: deps.ai, notifier: deps.notifier });
    await announceModelFallbacks(job.userId, deps.notifier);
    await reviewAfterScan(job.userId, agent, { ai: deps.ai, now: () => now });
    const stats = { outcome: scan.outcome, scanId: scan.scan_id, proposalIds, costMicroUsd: scan.cost_micro_usd };
    if (scan.outcome === 'failed') {
      // The scan ran and the model call failed: the provider's trouble, worth another try.
      const cause: FailureCause = /429|rate.?limit/i.test(scan.error ?? '') ? 'rate_limited' : 'scan_failed';
      await finish(runId, job, { ...stats, cause, retryable: true, error: scan.error }, deps.notifier, now);
      return;
    }
    // Everything else is the slot's answer - a refused answer, a spent budget or cap, and a
    // refused own key too (D69, D207): retrying the slot would not change any of them.
    const spent =
      scan.outcome === 'budget_reached' ||
      scan.outcome === 'cap_reached' ||
      scan.outcome === 'own_key_failed' ||
      scan.outcome === 'own_key_required';
    await finishRun(runId, spent ? 'degraded' : 'ok', stats);
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
  if (last) await reportGaveUp(runId, job, stats.cause, notifier, now);
}

/** Pushes past the default `high` floor: a scan the user scheduled did not happen (D74). */
export const GAVE_UP_SEVERITY = 'high';

/** The give-up notice in `language`. */
function gaveUpNotice(job: SlotAttemptJob, agentName: string, cause: FailureCause, language: string): NoticeText {
  const messages = messagesFor(language);
  return messages.scheduledScans.gaveUp(
    agentName,
    messages.scheduledScans.slot(job.slot),
    job.day,
    messages.scheduledScans.causes[cause],
  );
}

/**
 * D74: one message when a slot gives up, naming the agent, the slot and why.
 * A retry that later succeeds sends nothing, because this runs only on the
 * last attempt. The failed run on the Admin page's runs list is the record.
 *
 * It goes through `fanOut` against the run that gave up (D298), so quiet hours
 * and a mute hold it for the digest, where it is a line of its own rather than
 * a finding, and the ledger's dedupe key makes it once per run.
 */
async function reportGaveUp(
  runId: string,
  job: SlotAttemptJob,
  cause: FailureCause,
  notifier: Notifier,
  now: Date,
): Promise<void> {
  try {
    const [agent, settings, user] = await Promise.all([
      getAgent(job.userId, job.agentId),
      getOrCreateUserSettings(job.userId),
      getUser(job.userId),
    ]);
    if (user === null) return;
    const agentName = agent?.name ?? job.agentId;
    const localized: LocalizedTexts = {};
    for (const language of UI_LANGUAGES) {
      if (language !== 'en') localized[language] = gaveUpNotice(job, agentName, cause, language);
    }
    const result = await fanOut(
      job.userId,
      job.agentId,
      [
        {
          refKind: 'run',
          refId: runId,
          severity: GAVE_UP_SEVERITY,
          ...gaveUpNotice(job, agentName, cause, 'en'),
          localized,
        },
      ],
      settingsForNotification(settings, user.timezone),
      notifier,
      now,
    );
    logger().warn({ ...job, runId, cause, pushed: result.pushed, deferred: result.deferred }, 'scheduled_scan.gave_up');
  } catch (error) {
    logger().error({ err: error, ...job }, 'scheduled_scan.report_failed');
  }
}
