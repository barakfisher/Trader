/**
 * The queue scheduled scans wait in (D73): BullMQ, on the Redis the AI service
 * already uses, with its worker inside this process.
 *
 * The queue carries attempts, not policy. `scheduledScans.ts` decides what is
 * due and how often to retry, from Postgres; here one attempt becomes one job,
 * `AGENT_SCAN_CONCURRENCY` jobs run at once, and a job never fails as far as
 * BullMQ is concerned - `runSlotAttempt` records the outcome on its run and
 * returns, so the queue's own retries never repeat what the plan decides.
 *
 * The job id is the attempt's run key, so adding a job the queue already holds
 * is a no-op. BullMQ refuses ':' in an id, so the key's colons become '_'.
 */

import { Queue, Worker, type ConnectionOptions } from 'bullmq';

import type { Config } from '../config.js';
import { logger } from '../logger.js';
import type { ScanQueue, SlotAttemptJob } from './scheduledScans.js';

export const SCAN_QUEUE_NAME = 'agent-scans';

/** Kept so a repeated add in the same day finds the job and adds nothing. */
const KEEP_FINISHED_SECONDS = 3 * 24 * 60 * 60;

/** A run key as a job id BullMQ accepts. */
export function jobIdOf(runKey: string): string {
  return runKey.replaceAll(':', '_');
}

/** `redis://[user:pass@]host:port/db` as the options BullMQ's client takes. */
export function connectionOf(url: string): ConnectionOptions {
  const parsed = new URL(url);
  const db = Number(parsed.pathname.replace('/', '') || '0');
  return {
    host: parsed.hostname,
    port: Number(parsed.port || '6379'),
    db: Number.isInteger(db) ? db : 0,
    ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
    ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
    // A worker blocks on Redis; BullMQ requires the client not to give up.
    maxRetriesPerRequest: null,
  };
}

export interface RunningScanQueue extends ScanQueue {
  close(): Promise<void>;
}

/** The queue and its worker, started together; `run` is one attempt. */
export function startScanQueue(
  config: Pick<Config, 'REDIS_URL' | 'AGENT_SCAN_CONCURRENCY'>,
  run: (job: SlotAttemptJob) => Promise<void>,
): RunningScanQueue {
  const connection = connectionOf(config.REDIS_URL);
  const queue = new Queue<SlotAttemptJob>(SCAN_QUEUE_NAME, { connection });
  const worker = new Worker<SlotAttemptJob>(SCAN_QUEUE_NAME, async (job) => run(job.data), {
    connection,
    concurrency: config.AGENT_SCAN_CONCURRENCY,
  });
  worker.on('failed', (job, error) => {
    // `run` does not throw; reaching here is a bug in it, said loudly.
    logger().error({ jobId: job?.id, err: error }, 'scan_queue.job_threw');
  });
  worker.on('error', (error) => logger().warn({ err: error }, 'scan_queue.worker_error'));
  logger().info({ concurrency: config.AGENT_SCAN_CONCURRENCY }, 'scan_queue.started');

  return {
    async add(runKey, job) {
      await queue.add('attempt', job, {
        jobId: jobIdOf(runKey),
        removeOnComplete: { age: KEEP_FINISHED_SECONDS },
        removeOnFail: { age: KEEP_FINISHED_SECONDS },
      });
    },
    async close() {
      await worker.close();
      await queue.close();
    },
  };
}
