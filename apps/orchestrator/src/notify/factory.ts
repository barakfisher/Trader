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
import { logger } from '../logger.js';
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

  // The Telegram adapter lands in the next PR. Until it does, a configured
  // token still gets a null channel - but with a different reason, because
  // "you configured this and it is not wired up yet" and "you configured
  // nothing" are different problems with different fixes, and a single message
  // covering both would send somebody looking for a typo in a correct token.
  logger().warn(
    { channel: 'telegram' },
    'TELEGRAM_BOT_TOKEN is set but the Telegram adapter is not implemented yet',
  );
  return new NullNotifier(
    'the Telegram adapter is not implemented yet; the token is configured and unused',
  );
}
