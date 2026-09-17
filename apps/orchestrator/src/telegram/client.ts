/**
 * The Telegram Bot API client, and the `Notifier` the fan-out delivers through.
 *
 * `fetch` is a constructor argument rather than a global so the whole adapter -
 * the retry policy, the button rendering, the 4096-character limit - is
 * testable with no bot token and no network. That is the same choice the LLM
 * adapter made with its httpx transport, and for the same reason: a test suite
 * that needs a credential is one CI cannot run and a reviewer cannot trust.
 *
 * **This class never decides whether to send.** By the time `send` is called the
 * policy has run, the row is claimed, and the message is going out. A channel
 * that could decline would be a second policy with no access to the user's
 * settings, and the two would eventually disagree about a message the user
 * either did or did not receive.
 *
 * Retry policy: one retry, on 429 and 5xx, mirroring `openai_compatible.py`. A
 * 4xx from Telegram is our own request - a bad token, a blocked bot, a chat that
 * deleted itself - and asking again produces the same answer more slowly. The
 * notable one is 403: the user blocked the bot, which is a durable fact about
 * the world rather than a transient fault, and retrying it is pure noise.
 */

import { logger } from '../logger.js';
import type { DeliveryResult, Notifier, OutboundNotification } from '../notify/notifier.js';
import { encodeCallbackData, mintNonce, type CallbackAction } from './callbackToken.js';

/** Telegram truncates beyond this; we would rather cut deliberately. */
export const MAX_MESSAGE_CHARS = 4096;

/** Statuses worth exactly one more attempt. */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/** The buttons an actionable alert carries, in the order they are shown. */
const ACTIONS: { action: CallbackAction; label: string }[] = [
  { action: 'approve', label: 'Approve' },
  { action: 'reject', label: 'Reject' },
  { action: 'snooze', label: 'Snooze' },
];

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface TelegramClientOptions {
  botToken: string;
  /** Signs `callback_data`. Distinct from the bot token: see `webhook.ts`. */
  callbackSecret: string;
  /** Resolves the chat a user's alerts go to. Null when they never connected one. */
  resolveChatId: (userId: string) => Promise<string | null>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/**
 * Trim to the limit at a word boundary, marking that something was cut.
 *
 * Silently truncating a sentence about a number is the specific bad outcome
 * here: "NVDA fell 7.2% on volume of 3.1x its" reads as a complete and wrong
 * claim. The ellipsis is what stops a cut looking like a fact.
 */
export function clampMessage(text: string, limit = MAX_MESSAGE_CHARS): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${lastSpace > limit / 2 ? cut.slice(0, lastSpace) : cut}…`;
}

export class TelegramNotifier implements Notifier {
  readonly channel = 'telegram';

  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(private readonly options: TelegramClientOptions) {
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  private url(method: string): string {
    return `https://api.telegram.org/bot${this.options.botToken}/${method}`;
  }

  async send(notification: OutboundNotification): Promise<DeliveryResult> {
    const chatId = await this.options.resolveChatId(notification.userId);
    if (chatId === null) {
      // Not an error: the user simply has not connected a chat. Recorded on the
      // row as the reason, so "you never connected Telegram" and "Telegram is
      // down" do not read the same in the notification log.
      return { delivered: false, error: 'this user has no Telegram chat connected' };
    }

    const text = clampMessage(
      notification.body ? `${notification.title}\n\n${notification.body}` : notification.title,
    );

    return this.call('sendMessage', {
      chat_id: chatId,
      text,
      ...(notification.proposalId === undefined
        ? {}
        : { reply_markup: this.buttonsFor(notification.proposalId) }),
    });
  }

  /**
   * Inline buttons for an actionable alert.
   *
   * Every button gets its **own** nonce. Sharing one across the three would mean
   * that approving burns the nonce that rejecting would have used, so the second
   * tap - a user changing their mind within the same second - would be read as a
   * replay of the first rather than as the different act it is.
   */
  private buttonsFor(proposalId: string) {
    return {
      inline_keyboard: [
        ACTIONS.map(({ action, label }) => ({
          text: label,
          callback_data: encodeCallbackData(
            { proposalId, action, nonce: mintNonce() },
            this.options.callbackSecret,
          ),
        })),
      ],
    };
  }

  /** Acknowledge a tap, so Telegram stops showing the button's spinner. */
  async answerCallback(callbackQueryId: string, text: string): Promise<void> {
    // Failure here is deliberately swallowed: the decision has already been
    // applied and recorded, and throwing would turn a cosmetic spinner into a
    // failed webhook that Telegram then retries - re-delivering a callback
    // whose nonce is already spent.
    await this.call('answerCallbackQuery', { callback_query_id: callbackQueryId, text });
  }

  /** Send plain text with no buttons: command replies and confirmations. */
  async sendText(chatId: string, text: string): Promise<DeliveryResult> {
    return this.call('sendMessage', { chat_id: chatId, text: clampMessage(text) });
  }

  private async call(method: string, payload: unknown): Promise<DeliveryResult> {
    for (const attempt of [1, 2]) {
      let response: Response;
      try {
        response = await this.fetchImpl(this.url(method), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        // A transport failure is reported, never thrown: the fan-out records it
        // on the row and moves to the next finding.
        return { delivered: false, error: `transport error: ${(error as Error).message}` };
      }

      if (response.ok) return { delivered: true };

      const retryable = RETRYABLE.has(response.status);
      logger().warn(
        { method, status: response.status, attempt, willRetry: retryable && attempt === 1 },
        'telegram.http_error',
      );
      if (!retryable || attempt === 2) {
        return {
          delivered: false,
          error: `HTTP ${response.status}: ${await this.describe(response)}`,
        };
      }
    }
    return { delivered: false, error: 'retry loop ended without a response' };
  }

  /** Telegram's own error text, which names the cause far better than a status. */
  private async describe(response: Response): Promise<string> {
    try {
      const body = (await response.json()) as { description?: string };
      return body.description ?? 'no description';
    } catch {
      return 'unreadable body';
    }
  }
}
