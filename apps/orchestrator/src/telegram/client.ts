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
import { messagesFor } from '../notify/messages.js';
import type { DeliveryResult, Notifier, OutboundNotification } from '../notify/notifier.js';
import {
  BUSY_CALLBACK_DATA,
  encodeCallbackData,
  MAX_CALLBACK_PRICE_MINOR,
  mintNonce,
  type CallbackAction,
} from './callbackToken.js';

/** Telegram truncates beyond this; we would rather cut deliberately. */
export const MAX_MESSAGE_CHARS = 4096;

/** Statuses worth exactly one more attempt. */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/**
 * The buttons an actionable alert carries, in the order they are shown. Their
 * labels, the Undo button's and the placeholder's are in `notify/messages.ts`,
 * in the language of the user the message is for.
 */
const ACTIONS = ['approve', 'reject', 'snooze'] as const;

/**
 * Which buttons a message should carry once a tap has been handled.
 *
 * `decide` for a question that is still open, `undo` for an approval, `none`
 * for everything else - a rejection and an expiry have nothing left to press.
 * A trade proposal has its own two (D48): `trade` is Approve and Reject, and
 * `{ confirmAt }` is Confirm at the price its preview showed, and Reject.
 */
export type Keyboard = 'decide' | 'trade' | 'undo' | 'none' | { confirmAt: bigint };

/** Whether a Confirm button can carry this price (`MAX_CALLBACK_PRICE_MINOR`). */
export function confirmable(priceMinor: bigint): boolean {
  return priceMinor > 0n && priceMinor <= MAX_CALLBACK_PRICE_MINOR;
}

/** Telegram's `getUpdates` answer, left loose: the handler validates each update. */
export interface TelegramUpdate {
  update_id: number;
  [key: string]: unknown;
}

export type UpdatesResult =
  | { ok: true; updates: TelegramUpdate[] }
  | { ok: false; status: number | null; error: string };

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface TelegramClientOptions {
  botToken: string;
  /** Signs `callback_data`. Distinct from the bot token: see `webhook.ts`. */
  callbackSecret: string;
  /** Resolves the chat a user's alerts go to. Null when they never connected one. */
  resolveChatId: (userId: string) => Promise<string | null>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /**
   * The web app's public https origin. When present, every proposal message
   * carries an "Open in app" link to its page; see `proposalLink`.
   */
  webBaseUrl?: string | null;
}

/**
 * The web app's origin if Telegram will accept a link to it, else null.
 *
 * Telegram rejects a URL button pointing at `http://` or a private host, and it
 * rejects the *whole message* with it - so a local `http://127.0.0.1:5174` here
 * would turn every alert into a failed send. Such a value is dropped (the caller
 * logs why) and messages go out without the link, as they did before it existed.
 */
export function proposalLinkBase(value: string | undefined | null): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const privateHost = /^(localhost|127\.|10\.|192\.168\.|0\.0\.0\.0|\[::1\])/.test(url.hostname);
  if (url.protocol !== 'https:' || privateHost) return null;
  return url.origin + url.pathname.replace(/\/+$/, '');
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
        : {
            reply_markup: this.keyboardFor(
              notification.proposalId,
              notification.trade === true ? 'trade' : 'decide',
              notification.language,
            ),
          }),
    });
  }

  /**
   * Inline buttons for a proposal in a given state.
   *
   * Every button gets its **own** nonce, and every render mints fresh ones.
   * Sharing one across the three would mean that approving burns the nonce that
   * rejecting would have used, so the second tap - a user changing their mind
   * within the same second - would be read as a replay of the first rather than
   * as the different act it is. Fresh ones on re-render matter for Undo: the
   * Approve button that comes back after an undo must not carry the nonce the
   * first approval already spent.
   */
  private keyboardFor(proposalId: string, keyboard: Keyboard, language: string) {
    const messages = messagesFor(language);
    const button = (action: CallbackAction, label: string, priceMinor?: bigint) => ({
      text: label,
      callback_data: encodeCallbackData(
        { proposalId, action, nonce: mintNonce(), ...(priceMinor === undefined ? {} : { priceMinor }) },
        this.options.callbackSecret,
      ),
    });
    // The link stays through every state, a decided one included: the page is
    // where the audit trail is, and "what happened to this?" outlives the buttons.
    const base = this.options.webBaseUrl ?? null;
    const link = base
      ? [[{ text: messages.openInApp, url: `${base}/proposals/${encodeURIComponent(proposalId)}` }]]
      : [];
    if (typeof keyboard === 'object') {
      // A price no button can carry leaves Reject; the preview says to confirm in the app.
      const confirm = confirmable(keyboard.confirmAt)
        ? [button('confirm', messages.buttons.confirm, keyboard.confirmAt)]
        : [];
      return { inline_keyboard: [[...confirm, button('reject', messages.buttons.reject)], ...link] };
    }
    switch (keyboard) {
      case 'trade':
        return {
          inline_keyboard: [
            [button('approve', messages.buttons.approve), button('reject', messages.buttons.reject)],
            ...link,
          ],
        };
      case 'decide':
        return {
          inline_keyboard: [ACTIONS.map((action) => button(action, messages.buttons[action])), ...link],
        };
      case 'undo':
        return { inline_keyboard: [[button('undo', messages.undoButton)], ...link] };
      case 'none':
        // An empty keyboard removes it. Omitting `reply_markup` would leave the
        // old one in place, which is the opposite of what a terminal state needs.
        return { inline_keyboard: link };
    }
  }

  /**
   * Replace the buttons with one inert "Approving…" placeholder while a tap is
   * applied.
   *
   * Two jobs, and the second is the one that matters. It shows the tap
   * registered, which Telegram's own spinner does only on the one button and
   * only for a moment. And it takes the other buttons away: nothing else on the
   * message can be pressed until the outcome is known, so a nervous double tap
   * or an Approve-then-Reject cannot put two decisions in flight at once. A tap
   * on the placeholder is answered "still working" and does nothing.
   */
  async showWorking(
    chatId: string,
    messageId: number,
    action: CallbackAction,
    language: string,
  ): Promise<DeliveryResult> {
    return this.call('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: {
        inline_keyboard: [
          [{ text: messagesFor(language).working[action], callback_data: BUSY_CALLBACK_DATA }],
        ],
      },
    });
  }

  /** Put the right buttons back without touching the text: a tap that changed nothing. */
  async setKeyboard(
    chatId: string,
    messageId: number,
    proposalId: string,
    keyboard: Keyboard,
    language: string,
  ): Promise<DeliveryResult> {
    return this.call('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: this.keyboardFor(proposalId, keyboard, language),
    });
  }

  /** Acknowledge a tap, so Telegram stops showing the button's spinner. */
  async answerCallback(callbackQueryId: string, text: string): Promise<void> {
    // Failure here is deliberately swallowed: the decision has already been
    // applied and recorded, and throwing would turn a cosmetic spinner into a
    // failed webhook that Telegram then retries - re-delivering a callback
    // whose nonce is already spent.
    await this.call('answerCallbackQuery', { callback_query_id: callbackQueryId, text });
  }

  /**
   * Rewrite a message that has already been acted on.
   *
   * `answerCallbackQuery` alone is not enough, and the difference matters: the
   * answer is a toast that shows for a second and leaves nothing behind, so a
   * user scrolling back a day later sees an alert with three live-looking
   * buttons and no record of having pressed one. That is the same failure the
   * web inbox avoids by re-rendering from the server - a surface must not go on
   * describing a world that has moved.
   *
   * The keyboard is always sent, never left as it was: by the time this runs
   * the buttons are the "Approving…" placeholder, so "keep them" would keep the
   * placeholder. A snooze gets the three buttons back, because "not now" is not
   * a decision; an approval gets Undo; a rejection and an expiry get nothing,
   * because a live button on either invites a tap that can only be refused.
   */
  async editMessage(
    chatId: string,
    messageId: number,
    text: string,
    { proposalId, keyboard, language }: { proposalId: string; keyboard: Keyboard; language: string },
  ): Promise<DeliveryResult> {
    return this.call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: clampMessage(text),
      reply_markup: this.keyboardFor(proposalId, keyboard, language),
    });
  }

  /**
   * One long poll for updates, for installations with no public webhook URL.
   *
   * `offset` confirms everything before it, so Telegram drops those updates;
   * the caller advances it only after an update has been handled. The request
   * timeout is the poll's own plus a margin, or the abort would race the
   * answer Telegram is holding open.
   */
  async getUpdates(offset: number | null, timeoutSeconds: number): Promise<UpdatesResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.url('getUpdates'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          timeout: timeoutSeconds,
          allowed_updates: ['message', 'callback_query'],
          ...(offset === null ? {} : { offset }),
        }),
        signal: AbortSignal.timeout(timeoutSeconds * 1000 + this.timeoutMs),
      });
    } catch (error) {
      return { ok: false, status: null, error: `transport error: ${(error as Error).message}` };
    }
    if (!response.ok) {
      return { ok: false, status: response.status, error: await this.describe(response) };
    }
    try {
      const body = (await response.json()) as { result?: TelegramUpdate[] };
      return { ok: true, updates: Array.isArray(body.result) ? body.result : [] };
    } catch {
      return { ok: false, status: response.status, error: 'unreadable body' };
    }
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
