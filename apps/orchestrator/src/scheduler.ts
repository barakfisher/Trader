/**
 * Local scheduler.
 *
 * In Kubernetes a CronJob posts to /internal/runs and this timer is disabled
 * (SCHEDULER_ENABLED=false), so there is never more than one trigger path for a
 * given run - see DESIGN.md section 2. Both paths go through the same HTTP
 * endpoint and the same run-key deduplication.
 */

import type { Config } from './config.js';
import { logger } from './logger.js';

const SNAPSHOT_INTERVAL_MS = 60 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;

export function startScheduler(config: Config): void {
  if (process.env.SCHEDULER_ENABLED === 'false') {
    logger().info('local scheduler disabled; expecting an external trigger');
    return;
  }

  const trigger = async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${config.ORCHESTRATOR_PORT}/internal/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-key': config.INTERNAL_API_KEY },
        body: JSON.stringify({ kind: 'snapshot' }),
      });
      const body = (await response.json()) as { status?: string };
      logger().info({ status: body.status }, 'scheduled snapshot run');
    } catch (error) {
      logger().warn({ err: error }, 'scheduled snapshot trigger failed');
    }
  };

  // Hourly, with the run key collapsing repeats to one snapshot per local day.
  timer = setInterval(trigger, SNAPSHOT_INTERVAL_MS);
  setTimeout(trigger, 10_000).unref();
  logger().info({ intervalMs: SNAPSHOT_INTERVAL_MS }, 'local scheduler started');
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
