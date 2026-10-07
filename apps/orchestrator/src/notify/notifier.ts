/**
 * The notification channel boundary.
 *
 * Guideline 6: external dependencies sit behind an interface, and adding one
 * must never touch a call site. `MarketDataProvider` and the LLM provider
 * factory are the same shape, and the reason is the same - the fan-out decides
 * *what* to say and *whether* to say it, and should not know that Telegram has
 * a bot token, a chat id, or a 4096-character limit.
 *
 * Telegram arrives in the next PR as one more implementation of this interface.
 * It is deliberately not here: the fan-out, the dedupe guarantee and the quiet
 * hours are all testable without a bot token, and a PR that needs a credential
 * to run its own tests is a PR nobody can review offline.
 *
 * **A notifier never decides whether to send.** By the time `send` is called the
 * policy has already run and the row is already written. A channel that could
 * decline would be a second policy, in a place with no access to the user's
 * settings, and the two would eventually disagree about a message the user
 * either did or did not receive.
 */

/** What a channel is asked to deliver. Already routed, already deduplicated. */
export interface OutboundNotification {
  userId: string;
  /** What is being announced, for the channel to render however suits it. */
  title: string;
  body: string;
  /** Present when the user can act on it; a channel may offer inline buttons. */
  proposalId?: string;
  /** The proposal is a buy or sell: Approve and Reject only (D48), and Approve previews. */
  trade?: boolean;
  severity: string;
  /**
   * The user's interface language. The title and body arrive already in it; a
   * channel uses it for whatever it adds itself, such as button labels.
   */
  language: string;
}

export interface DeliveryResult {
  delivered: boolean;
  /** Present when `delivered` is false. Stored on the row, not just logged. */
  error?: string;
}

export interface Notifier {
  /** The `notifications.channel` value this writes, so the log names it. */
  readonly channel: string;
  send(notification: OutboundNotification): Promise<DeliveryResult>;
}

/**
 * The notifier for an installation with no channel configured.
 *
 * It reports `delivered: false` with a reason rather than throwing, and rather
 * than claiming success. Both alternatives are worse in the same direction:
 * throwing turns "Telegram is not set up" into a failed scan, and pretending to
 * deliver writes `status = 'sent'` for a message that reached nobody - which is
 * the one lie this table exists to prevent.
 *
 * This mirrors `NullProvider` in the LLM layer, and for the same reason: the
 * distinction that matters is between a channel deliberately switched off and
 * one that is broken, and only the code that built the notifier knows which.
 */
export class NullNotifier implements Notifier {
  readonly channel: string;

  constructor(
    private readonly reason: string,
    channel = 'telegram',
  ) {
    this.channel = channel;
  }

  async send(): Promise<DeliveryResult> {
    return { delivered: false, error: this.reason };
  }
}
