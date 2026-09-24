/**
 * Pulls Telegram updates by long polling, for an installation Telegram cannot
 * push to.
 *
 * **Why this exists.** The webhook route was built in M4 and has never been
 * registered: `setWebhook` needs a public HTTPS URL, which arrives with M7's
 * ingress. Until then every button tap sat in Telegram's queue and reached
 * nothing - the bot sent alerts, the user tapped Approve, the spinner ran out,
 * and the web app never heard about it. M4 was verified by a hand-run script
 * that polled and replayed updates at the webhook, and that script left with
 * the session that wrote it. This is that bridge, made part of the service.
 *
 * **One transport at a time.** Telegram refuses `getUpdates` with 409 while a
 * webhook is registered, and two pollers on one token steal each other's
 * updates. So `TELEGRAM_UPDATES` chooses: `polling` (the default, because no
 * installation has a webhook yet), `webhook` once M7 registers one, or `off`.
 * A 409 is logged as the misconfiguration it is rather than retried quietly.
 *
 * **At-least-once, and that is safe.** The offset is advanced only after an
 * update has been handled, so a crash mid-update re-delivers it. A re-delivered
 * callback carries a nonce that is already spent, which the state machine
 * answers with the current state - the same answer a double tap gets.
 */

import { logger } from '../logger.js';
import type { TelegramNotifier, TelegramUpdate } from './client.js';

/** How long Telegram holds each poll open when there is nothing to deliver. */
export const POLL_TIMEOUT_SECONDS = 25;

/** The first wait after a failed poll; doubles per consecutive failure. */
export const INITIAL_BACKOFF_MS = 1_000;

/** The longest wait between failed polls. */
export const MAX_BACKOFF_MS = 60_000;

export interface PollerOptions {
  /** Hands one update to the shared handler. Expected never to throw. */
  handle: (update: TelegramUpdate) => Promise<void>;
  /** Injectable so tests do not wait out a real backoff. */
  sleep?: (ms: number) => Promise<void>;
}

export class TelegramPoller {
  private running = false;
  private offset: number | null = null;
  private failures = 0;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly telegram: TelegramNotifier,
    private readonly options: PollerOptions,
  ) {
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    logger().info({ transport: 'polling' }, 'telegram.poller_started');
    void this.loop();
  }

  /** Stops after the poll in flight returns. Nothing is lost: unconfirmed updates wait. */
  stop(): void {
    this.running = false;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const ok = await this.pollOnce();
      if (!ok && this.running) await this.sleep(this.backoffMs());
    }
  }

  private backoffMs(): number {
    return Math.min(INITIAL_BACKOFF_MS * 2 ** (this.failures - 1), MAX_BACKOFF_MS);
  }

  /**
   * One poll, and every update it returned. Exposed for tests; the loop is the
   * only production caller. Returns false when the poll itself failed.
   */
  async pollOnce(): Promise<boolean> {
    const result = await this.telegram.getUpdates(this.offset, POLL_TIMEOUT_SECONDS);
    if (!result.ok) {
      this.failures += 1;
      if (result.status === 409) {
        logger().error(
          { status: 409, error: result.error },
          'telegram.poller_conflict: a webhook is registered for this bot, or another ' +
            'process is polling it. Set TELEGRAM_UPDATES=webhook, or deleteWebhook.',
        );
      } else {
        logger().warn(
          { status: result.status, error: result.error, failures: this.failures },
          'telegram.poller_failed',
        );
      }
      return false;
    }

    this.failures = 0;
    for (const update of result.updates) {
      // Sequential, not concurrent: two taps on one message must be applied in
      // the order they were made, or an Approve-then-Undo could land reversed.
      await this.options.handle(update);
      this.offset = update.update_id + 1;
    }
    return true;
  }
}
