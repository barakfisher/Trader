import { logger } from '../../logger.js';
import { query, queryOne } from '../pool.js';

export interface RunRow {
  id: string;
  kind: string;
  run_key: string;
  status: string;
  started_at: Date;
  finished_at: Date | null;
}


/**
 * How long a run may sit in `running` before another trigger may take it over.
 *
 * Without this, a process killed mid-run leaves its key claimed forever and that
 * work never happens again - for a daily key, that is a day permanently skipped.
 * The window has to exceed the longest plausible run and stay well under the
 * shortest gap between triggers.
 */
const STALE_RUN_MINUTES = 30;

/**
 * How long a run that heartbeats (`runs.heartbeat_at`, migration 0031) may go
 * without one before it counts as dead. A background run - the universe
 * rescreen - beats every 30 s from the process doing the work, so five missed
 * beats is a process that is gone, not one that is slow. It replaces the
 * started-at rule for such a run, which would reclaim a live rescreen that
 * simply took longer than half an hour.
 */
export const HEARTBEAT_STALE_MINUTES = 5;

/** Postgres's unique_violation: here, the one-running-rescreen index (0031). */
const UNIQUE_VIOLATION = '23505';

export interface ClaimRunInput {
  /** Null for the installation's own work, which belongs to no account. */
  userId: string | null;
  /** The agent the run works for; null exactly when `userId` is (0036's `runs_agent_follows_user`). */
  agentId: string | null;
  kind: string;
  runKey: string;
  trigger: string;
  /**
   * Whether a run under this key that *failed* may be claimed again. Off for
   * every kind but the rescreen: a failed scan is retried by the next bucket's
   * key, while a failed rescreen keeps a fetch cache that only a retry under
   * the same key - the same day - can resume from.
   */
  retryFailed?: boolean;
}

/**
 * Claim a run, or report that someone already has it.
 *
 * The claim is the INSERT itself: `run_key` is unique per agent (the
 * installation's runs, with no agent, count as one), so exactly one caller can
 * succeed no matter how many fire at once, across processes and replicas. A
 * previous attempt that died mid-flight is reclaimed after STALE_RUN_MINUTES;
 * anything else already claimed returns `claimed: false` and the caller stops.
 */
export async function claimRun(
  input: ClaimRunInput,
): Promise<{ claimed: boolean; runId: string | null; existingStatus?: string }> {
  const insert = () =>
    queryOne<{ id: string }>(
      `INSERT INTO runs (user_id, agent_id, kind, run_key, trigger, status)
       VALUES ($1, $2, $3, $4, $5, 'running')
       ON CONFLICT (agent_id, run_key) DO NOTHING
       RETURNING id`,
      [input.userId, input.agentId, input.kind, input.runKey, input.trigger],
    );
  let inserted: { id: string } | null;
  try {
    inserted = await insert();
  } catch (error) {
    // `ON CONFLICT (agent_id, run_key)` covers the run key only. A second rescreen under
    // another key - yesterday's still running past midnight - meets the
    // partial unique index instead. A live one is a refusal, not a failure.
    if ((error as { code?: string }).code !== UNIQUE_VIOLATION) throw error;
    // A dead one is not (independent task 12). Its key names its own day, so
    // nothing would ever claim that key again to reclaim it, and every later
    // day's key met this index - the button and the CronJob refused forever,
    // until someone edited the row. Close it out and claim once more; the
    // rescreen's fetch cache is not tied to a key, so the new run resumes.
    const abandoned = await abandonDeadRuns(input.kind, input.runKey);
    if (abandoned === 0) {
      return { claimed: false, runId: null, existingStatus: 'running (another run of this kind)' };
    }
    try {
      inserted = await insert();
    } catch (retryError) {
      if ((retryError as { code?: string }).code !== UNIQUE_VIOLATION) throw retryError;
      return { claimed: false, runId: null, existingStatus: 'running (another run of this kind)' };
    }
  }
  if (inserted) return { claimed: true, runId: inserted.id };

  // A run that heartbeats is dead when its heartbeat is stale; one that never
  // has, when it started too long ago. A reclaimed heartbeating run starts
  // with a fresh beat, so it is not reclaimed again before its new owner beats.
  const reclaimed = await queryOne<{ id: string }>(
    `UPDATE runs
        SET status = 'running', started_at = now(), finished_at = NULL, trigger = $2,
            heartbeat_at = CASE WHEN heartbeat_at IS NULL THEN NULL ELSE now() END
      WHERE run_key = $1 AND agent_id IS NOT DISTINCT FROM $6::uuid
        AND ((status = 'failed' AND $5::boolean)
             OR (status = 'running'
                 AND CASE WHEN heartbeat_at IS NULL
                          THEN started_at < now() - ($3 || ' minutes')::interval
                          ELSE heartbeat_at < now() - ($4 || ' minutes')::interval END))
      RETURNING id`,
    [
      input.runKey,
      input.trigger,
      String(STALE_RUN_MINUTES),
      String(HEARTBEAT_STALE_MINUTES),
      input.retryFailed ?? false,
      input.agentId,
    ],
  );
  if (reclaimed) {
    logger().warn({ runKey: input.runKey }, 'reclaimed a failed run, or one left running by a dead process');
    return { claimed: true, runId: reclaimed.id };
  }

  const existing = await queryOne<{ status: string }>(
    'SELECT status FROM runs WHERE run_key = $1 AND agent_id IS NOT DISTINCT FROM $2::uuid',
    [input.runKey, input.agentId],
  );
  return { claimed: false, runId: null, existingStatus: existing?.status };
}

/**
 * Mark failed every run of `kind` left `running` by a dead process, naming the
 * run that found it. "Dead" is `claimRun`'s own test for reclaiming a key: a
 * stale heartbeat, or - for a run that never beat, such as a rescreen whose
 * process died between the claim and its first beat - a start older than
 * STALE_RUN_MINUTES.
 */
async function abandonDeadRuns(kind: string, supersededBy: string): Promise<number> {
  const rows = await query<{ run_key: string }>(
    `-- agent-blind: a kind-wide sweep for the installation's rescreen, which has no agent.
     UPDATE runs
        SET status = 'failed', finished_at = now(),
            stats = COALESCE(stats, '{}'::jsonb) || jsonb_build_object(
              'error', 'abandoned: its process stopped before finishing',
              'supersededBy', $4::text)
      WHERE kind = $1 AND status = 'running'
        AND CASE WHEN heartbeat_at IS NULL
                 THEN started_at < now() - ($2 || ' minutes')::interval
                 ELSE heartbeat_at < now() - ($3 || ' minutes')::interval END
      RETURNING run_key`,
    [kind, String(STALE_RUN_MINUTES), String(HEARTBEAT_STALE_MINUTES), supersededBy],
  );
  for (const row of rows) {
    logger().warn({ runKey: row.run_key, supersededBy }, 'closed a run whose process stopped heartbeating');
  }
  return rows.length;
}

/** Whether any run, in any state, holds `runKey`. */
export async function runKeyExists(runKey: string): Promise<boolean> {
  const row = await queryOne<{ exists: boolean }>(
    `-- agent-blind: asked only of the installation's rescreen key, which has no agent.
     SELECT EXISTS (SELECT 1 FROM runs WHERE run_key = $1) AS exists`,
    [runKey],
  );
  return row?.exists ?? false;
}

export async function finishRun(
  runId: string,
  status: 'ok' | 'degraded' | 'failed' | 'skipped',
  stats: unknown = {},
): Promise<void> {
  await query(
    `-- agent-blind: addressed by the run's own id.
     UPDATE runs SET status = $2, finished_at = now(), stats = $3::jsonb WHERE id = $1`,
    [runId, status, JSON.stringify(stats)],
  );
}

/** Most recent runs, newest first. Backs the "did anything run today?" check. */
export function listRuns(userId: string, kind?: string, limit = 50): Promise<RunRow[]> {
  return query<RunRow>(
    `-- agent-blind: the run history is the user's, every kind; an agent filter arrives with
     -- Stage 2's views, and must then leave out the agent-blind kinds (§3.3c).
     SELECT id, kind, run_key, status, started_at, finished_at
       FROM runs
      WHERE user_id = $1 AND ($2::text IS NULL OR kind = $2)
      ORDER BY started_at DESC
      LIMIT $3`,
    [userId, kind ?? null, limit],
  );
}

export interface AdminRunRow extends RunRow {
  user_id: string | null;
  trigger: string;
}

/**
 * Most recent runs of every user and of none, newest first - the admin's view.
 * `listRuns` answers "did my work happen?"; this answers "did the installation's
 * work happen?", which includes runs with no `user_id` at all.
 */
export function listAllRuns(kind?: string, limit = 100): Promise<AdminRunRow[]> {
  return query<AdminRunRow>(
    `-- agent-blind: the admin's view of every account's and the installation's runs.
     SELECT id, user_id, kind, run_key, trigger, status, started_at, finished_at
       FROM runs
      WHERE ($1::text IS NULL OR kind = $1)
      ORDER BY started_at DESC
      LIMIT $2`,
    [kind ?? null, limit],
  );
}

/**
 * The last finished run of `kind`, with what it recorded.
 *
 * The digest reads a topic scan's `stats.skipped` from here: that map is the only
 * record of which topics a scan could not measure, and "not measured" must not
 * be reported as "nothing moved".
 */
export function getLatestFinishedRun(
  userId: string,
  kind: string,
): Promise<{ started_at: Date; status: string; stats: unknown } | null> {
  return queryOne(
    `-- agent-blind: asked only of agent-blind kinds (news_collect, topic_scan), §3.3c.
     SELECT started_at, status, stats
       FROM runs
      WHERE user_id = $1 AND kind = $2 AND finished_at IS NOT NULL
      ORDER BY started_at DESC
      LIMIT 1`,
    [userId, kind],
  );
}

/** One attempt at a scheduled scan's slot (D69), oldest first. */
export interface SlotAttemptRow {
  run_key: string;
  status: string;
  finished_at: Date | null;
  stats: Record<string, unknown>;
}

/**
 * Every attempt at one agent's slot: the runs whose key starts with the slot's
 * key (`agent_scan:<agent>:<day>:<slot>:<n>`, migration 0048). Postgres is the
 * truth about a slot, not the queue: a restart or a lost Redis can neither
 * repeat an attempt nor forget one.
 */
export function listSlotAttempts(agentId: string, slotKey: string): Promise<SlotAttemptRow[]> {
  return query<SlotAttemptRow>(
    `SELECT run_key, status, finished_at, stats
       FROM runs
      -- starts_with, not LIKE: '_' in the keys would be a wildcard there.
      WHERE agent_id = $1 AND kind = 'agent_scan' AND starts_with(run_key, $2 || ':')
      ORDER BY started_at`,
    [agentId, slotKey],
  );
}
