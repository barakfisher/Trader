/**
 * Orchestrator entrypoint.
 *
 * Milestone 1: REST API, valuation, import and the daily snapshot timer.
 * Milestone 4 adds the proposal state machine and the Telegram bot - whose
 * updates are long-polled here until a webhook URL exists.
 */

import { serve } from '@hono/node-server';

import { AiClient } from '@traders/shared/ai';

import { loadConfig } from './config.js';
import { closePool, initPool } from './db/pool.js';
import { createApp } from './http/app.js';
import { initLogger, logger } from './logger.js';
import { buildNotifier } from './notify/factory.js';
import { startScheduler, stopScheduler } from './scheduler.js';
import { TelegramNotifier } from './telegram/client.js';
import { TelegramPoller } from './telegram/poller.js';
import { handleTelegramUpdate } from './telegram/updates.js';

function main(): void {
  const config = loadConfig();
  const log = initLogger(config.LOG_LEVEL, config.isProduction);
  log.info(
    { env: config.APP_ENV, timezone: config.APP_TIMEZONE, baseCurrency: config.BASE_CURRENCY },
    'orchestrator starting',
  );

  initPool(config.DATABASE_URL);
  const ai = new AiClient({
    baseUrl: config.AI_SERVICE_URL,
    internalApiKey: config.INTERNAL_API_KEY,
  });

  // Built once and shared: the poller answers taps through the same client the
  // fan-out sends alerts with.
  const notifier = buildNotifier(config);
  const app = createApp(config, ai, notifier);
  const server = serve({ fetch: app.fetch, port: config.ORCHESTRATOR_PORT }, (info) =>
    log.info({ port: info.port }, 'orchestrator listening'),
  );

  startScheduler(config);

  const poller =
    config.TELEGRAM_UPDATES === 'polling' && notifier instanceof TelegramNotifier
      ? new TelegramPoller(notifier, {
          handle: (update) => handleTelegramUpdate({ config, notifier, ai }, update),
        })
      : null;
  poller?.start();
  if (poller === null && notifier instanceof TelegramNotifier) {
    log.info({ transport: config.TELEGRAM_UPDATES }, 'telegram updates not polled');
  }

  const shutdown = (signal: string) => {
    log.info({ signal }, 'shutting down');
    stopScheduler();
    poller?.stop();
    server.close(async () => {
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
