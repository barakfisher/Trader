/**
 * Orchestrator entrypoint.
 *
 * Milestone 1: REST API, valuation, import and the daily snapshot timer.
 * Milestone 4 adds the proposal state machine and the Mastra workflow that
 * waits on it (see src/mastra/README.md), with the Telegram bot still to come.
 */

import { serve } from '@hono/node-server';

import { AiClient } from '@traders/shared/ai';

import { loadConfig } from './config.js';
import { closePool, initPool } from './db/pool.js';
import { createApp } from './http/app.js';
import { initLogger, logger } from './logger.js';
import { PROPOSAL_LIFECYCLE_ID, proposalLifecycle } from './mastra/proposalLifecycle.js';
import { closeWorkflowRuntime, initWorkflowRuntime } from './mastra/workflowRuntime.js';
import { startScheduler, stopScheduler } from './scheduler.js';

function main(): void {
  const config = loadConfig();
  const log = initLogger(config.LOG_LEVEL, config.isProduction);
  log.info(
    { env: config.APP_ENV, timezone: config.APP_TIMEZONE, baseCurrency: config.BASE_CURRENCY },
    'orchestrator starting',
  );

  initPool(config.DATABASE_URL);
  // After the pool, because the workflow store borrows it rather than opening
  // connections of its own.
  initWorkflowRuntime({ workflows: { [PROPOSAL_LIFECYCLE_ID]: proposalLifecycle } });

  const ai = new AiClient({
    baseUrl: config.AI_SERVICE_URL,
    internalApiKey: config.INTERNAL_API_KEY,
  });

  const app = createApp(config, ai);
  const server = serve({ fetch: app.fetch, port: config.ORCHESTRATOR_PORT }, (info) =>
    log.info({ port: info.port }, 'orchestrator listening'),
  );

  startScheduler(config);

  const shutdown = (signal: string) => {
    log.info({ signal }, 'shutting down');
    stopScheduler();
    server.close(async () => {
      await closeWorkflowRuntime();
      await closePool();
      process.exit(0);
    });
    // Do not hang forever on a stuck connection.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => logger().error({ reason }, 'unhandled rejection'));
}

main();
