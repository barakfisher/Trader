/**
 * Local scheduler.
 *
 * In Kubernetes a CronJob posts to /internal/runs and this timer is disabled
 * (SCHEDULER_ENABLED=false), so there is never more than one trigger path for a
 * given run - see DESIGN.md section 2. Both paths go through the same HTTP
 * endpoint, and that endpoint - not this file - decides whether a trigger is a
 * repeat. The timers here are deliberately dumber than the cadence they produce:
 * they ask often, and the run key answers.
 */

import type { Config } from './config.js';
import { logger } from './logger.js';

/**
 * How often each kind is offered the chance to run.
 *
 * Both are more frequent than the work they trigger, which is intentional. The
 * run-key bucket collapses the extras, so a missed tick costs at most one
 * interval rather than a whole day - the failure mode of a timer that fires
 * exactly once per period is that a restart at the wrong moment skips it
 * silently, and a silently skipped run looks exactly like a quiet market.
 */
const INTERVALS_MS: Record<string, number> = {
  snapshot: 60 * 60 * 1000,
  portfolio_scan: 15 * 60 * 1000,
  // Hourly against a daily bucket: the extras cost one HTTP request each and
  // mean a restart cannot skip the day's history.
  backfill: 60 * 60 * 1000,
  // Matches its run bucket rather than firing more often than it: unlike a scan,
  // a repeated sweep has nothing to collapse - it is already idempotent, since a
  // proposal already marked expired produces no transition.
  proposal_sweep: 15 * 60 * 1000,
  // Hourly against a daily bucket, like backfill and for the same reason: the
  // extras cost one HTTP request each, and a restart at the wrong moment cannot
  // swallow the day's digest - which, unlike a skipped scan, cannot be caught
  // up later, because the findings it would have carried are already marked.
  daily_digest: 60 * 60 * 1000,
};

/** Stagger the first run of each kind so a restart does not fire both at once. */
const FIRST_RUN_DELAY_MS: Record<string, number> = {
  // Backfill goes first: a scan that runs before the history exists finds
  // nothing and says so, which is correct and useless.
  backfill: 8_000,
  snapshot: 20_000,
  portfolio_scan: 40_000,
  proposal_sweep: 55_000,
  // Last: the digest reports on what the scan and the sweep just did, so
  // running it first would describe the previous cycle.
  daily_digest: 70_000,
};

const timers: NodeJS.Timeout[] = [];

export function startScheduler(config: Config): void {
  if (process.env.SCHEDULER_ENABLED === 'false') {
    logger().info('local scheduler disabled; expecting an external trigger');
    return;
  }

  for (const [kind, intervalMs] of Object.entries(INTERVALS_MS)) {
    const trigger = () => triggerRun(config, kind);
    timers.push(setInterval(trigger, intervalMs));
    setTimeout(trigger, FIRST_RUN_DELAY_MS[kind] ?? 10_000).unref();
    logger().info({ kind, intervalMs }, 'scheduled run registered');
  }
}

async function triggerRun(config: Config, kind: string): Promise<void> {
  try {
    const response = await fetch(`http://127.0.0.1:${config.ORCHESTRATOR_PORT}/internal/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': config.INTERNAL_API_KEY },
      body: JSON.stringify({ kind, trigger: 'scheduler' }),
    });
    const body = (await response.json()) as { status?: string; reason?: string };
    // 'skipped' is the common case and is not a problem: it means the bucket has
    // already been served. Logged at debug so the ordinary path stays quiet.
    const log = logger();
    if (body.status === 'skipped') log.debug({ kind, reason: body.reason }, 'scheduled run skipped');
    else log.info({ kind, status: body.status }, 'scheduled run');
  } catch (error) {
    logger().warn({ kind, err: error }, 'scheduled run trigger failed');
  }
}

export function stopScheduler(): void {
  while (timers.length) clearInterval(timers.pop());
}
