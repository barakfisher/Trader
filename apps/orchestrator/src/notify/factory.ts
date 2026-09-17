/**
 * Builds the configured notification channel. The only place that names one.
 *
 * This is `build_llm` for notifications, and it is the same shape for the same
 * reason (guideline 6): the fan-out receives a `Notifier` and never learns
 * which. When the Telegram adapter lands it is a branch in this function and a
 * new file beside `notifier.ts`, and nothing in `services/notifications.ts`
 * changes.
 *
 * **A missing credential degrades, it does not throw.** Notifications are not
 * the product - the observations feed is - so an installation with no bot token
 * must still scan, still analyse, still record. What it must *not* do is go
 * quiet without saying so, which is why the null channel carries the reason
 * into every row it declines rather than being silently skipped.
 *
 * This deliberately does not mirror the LLM factory's "raise in production"
 * rule. An LLM misconfiguration in production means a core feature is silently
 * missing; a missing notification channel is visible in the notifications log
 * on the very first scan, with the reason attached. The failure announces
 * itself, so it does not need to stop the boot.
 */

import type { Config } from '../config.js';
import { findTelegramBindingByUser } from '../db/queries.js';
import { logger } from '../logger.js';
import { TelegramNotifier } from '../telegram/client.js';
import { NullNotifier, type Notifier } from './notifier.js';

export function buildNotifier(config: Config): Notifier {
  if (!config.TELEGRAM_BOT_TOKEN) {
    logger().info(
      { channel: 'telegram' },
      'no notification channel configured; findings will be recorded, not pushed',
    );
    return new NullNotifier(
      'TELEGRAM_BOT_TOKEN is not set, so there is no channel to deliver on',
    );
  }

  if (!config.TELEGRAM_SIGNING_SECRET) {
    // A token with no callback secret can send, but every inline button it
    // rendered would be unverifiable - so it would deliver alerts nobody could
    // act on. Refused as a configuration gap with its own message, because "you
    // set half of this" is a different problem from "you set none of it".
    logger().warn({ channel: 'telegram' }, 'TELEGRAM_SIGNING_SECRET is not set');
    return new NullNotifier(
      'TELEGRAM_BOT_TOKEN is set but TELEGRAM_SIGNING_SECRET is not, so no button could be trusted',
    );
  }

  logger().info({ channel: 'telegram' }, 'telegram notifier selected');
  return new TelegramNotifier({
    botToken: config.TELEGRAM_BOT_TOKEN,
    callbackSecret: config.TELEGRAM_SIGNING_SECRET,
    // Looked up per send rather than cached: a user can connect, disconnect and
    // reconnect a chat between two scans, and a cached id would keep alerting a
    // chat the user deliberately detached.
    resolveChatId: async (userId) => (await findTelegramBindingByUser(userId))?.chat_id ?? null,
  });
}
