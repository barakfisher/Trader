/**
 * Inbound Telegram updates - a tap on a button, or a command - and what each
 * one does (FLOWS.md F4).
 *
 * **Transport-independent on purpose.** An update reaches this module one of
 * two ways: pushed to `POST /telegram/webhook` once a public HTTPS URL exists,
 * or pulled by `TelegramPoller` until then. The handling must be identical, so
 * it lives here and both transports call `handleTelegramUpdate`. Nothing here
 * trusts its input, and two of the three checks that guard the ledger are
 * applied here rather than at the transport:
 *
 *   - **The chat binding.** An unbound chat is ignored *in silence* - replying
 *     would confirm the bot exists to whoever found it.
 *   - **The signed callback, and its nonce.** A forwarded message keeps working
 *     buttons, so the payload carries an HMAC and a single-use nonce. The nonce
 *     is burned by the unique index on `proposal_transitions.idempotency_key`,
 *     so a replay loses a database race rather than passing a check.
 *
 * The third, the webhook's secret header, belongs to the webhook: a long poll
 * is a request *we* make with the bot token, so there is no caller to doubt.
 *
 * **Nothing here throws to its caller.** Both transports treat a thrown update
 * as undeliverable, and both would then re-deliver a callback whose nonce is
 * already spent. Errors are logged; the user hears through the callback answer.
 */

import { z } from 'zod';

import type { Config } from '../config.js';
import {
  deleteTelegramBinding,
  findProposal,
  findTelegramBindingByChat,
  getOrCreateUserSettings,
  getUser,
  listProposals,
  muteUntil,
  redeemTelegramBindToken,
} from '../db/queries.js';
import { logger } from '../logger.js';
import type { Notifier } from '../notify/notifier.js';
import {
  effectiveState,
  undoableUntil,
  UNDO_WINDOW_SECONDS,
  type RefusalReason,
} from '../services/proposalState.js';
import { applyDecision, factsOf } from '../services/proposals.js';
import { MESSAGES, messagesFor, observationTextIn, type Messages } from '../notify/messages.js';
import { decodeBindToken } from './bindToken.js';
import { BUSY_CALLBACK_DATA, decodeCallbackData } from './callbackToken.js';
import { TelegramNotifier, type Keyboard } from './client.js';

/** What handling an update needs, whichever transport delivered it. */
export interface UpdateDeps {
  config: Config;
  notifier: Notifier;
}

/** How long a `/mute` lasts when the user names no duration. */
export const DEFAULT_MUTE_HOURS = 8;

/** The longest mute a single command may set. Beyond this, use the settings page. */
export const MAX_MUTE_HOURS = 24 * 7;

/** How long a snooze tapped from Telegram lasts. The bot has no time picker. */
export const TELEGRAM_SNOOZE_HOURS = 4;

/**
 * Telegram's update envelope, narrowed to the two kinds this bot handles.
 *
 * Deliberately permissive - `passthrough` everywhere, every field optional -
 * because Telegram adds fields without warning and an update we cannot parse
 * must be ignored rather than made into a 500 that triggers a retry storm.
 */
const updateSchema = z
  .object({
    message: z
      .object({
        text: z.string().optional(),
        chat: z.object({ id: z.number() }).passthrough(),
        from: z.object({ username: z.string().optional() }).passthrough().optional(),
      })
      .passthrough()
      .optional(),
    callback_query: z
      .object({
        id: z.string(),
        data: z.string().optional(),
        message: z
          .object({
            // Both needed to rewrite the message after a decision: the id says
            // which one, and the text is what the outcome line is appended to.
            message_id: z.number(),
            text: z.string().optional(),
            chat: z.object({ id: z.number() }).passthrough(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/**
 * Every sentence below is in `notify/messages.ts`, in each interface language:
 * the toast after a tap (`decisionReplies`, one line each - the chat is not a
 * UI), the refusals that need their own words, and the outcome line appended
 * to the message once a decision is in. The outcome line is separate from the
 * toast because the two are read at different moments: the toast is seen now,
 * the line is what the user finds when they scroll back tomorrow.
 *
 * A chat with no bound user is answered in English: nobody's language is known.
 */

/** The toast for arriving in `state`; a snooze names how long it lasts. */
function decisionReply(messages: Messages, state: string): string | undefined {
  return state === 'snoozed' ? messages.snoozedFor(TELEGRAM_SNOOZE_HOURS) : messages.decisionReplies[state];
}

/** A refusal that needs its own words; the rest are answered with the current state. */
function refusalReply(messages: Messages, reason: RefusalReason): string | undefined {
  return reason === 'undo_window_closed'
    ? messages.undoTooLate(UNDO_WINDOW_SECONDS)
    : messages.refusalReplies[reason];
}

/**
 * Which buttons a message carries once its proposal is in a given state.
 * An approval carries Undo only while its window is open.
 */
function keyboardFor(state: string, undoOpen: boolean): Keyboard {
  if (state === 'pending' || state === 'snoozed') return 'decide';
  if (state === 'approved' && undoOpen) return 'undo';
  return 'none';
}

/** Whether a proposal can still be undone right now, read fresh from the row. */
async function undoIsOpen(userId: string, proposalId: string, now: Date): Promise<boolean> {
  const row = await findProposal(userId, proposalId);
  const until = row === null ? null : undoableUntil(factsOf(row));
  return until !== null && now.getTime() <= until.getTime();
}

/**
 * Take the Undo button off an approval once its window has closed.
 *
 * Telegram has no expiring buttons, so this is a timer - in-process, and lost
 * if the process restarts inside the window. That is acceptable because it is
 * only tidiness: the state machine refuses a late Undo regardless, and the
 * refusal itself removes the button. The row is re-read when the timer fires,
 * so an approval that was undone in the meantime keeps the buttons it now has.
 */
function scheduleUndoRemoval(
  telegram: TelegramNotifier,
  target: { userId: string; proposalId: string; chatId: string; messageId: number; language: string },
): void {
  const timer = setTimeout(() => {
    void (async () => {
      try {
        const row = await findProposal(target.userId, target.proposalId);
        if (row === null || effectiveState(factsOf(row), new Date()) !== 'approved') return;
        await telegram.setKeyboard(
          target.chatId,
          target.messageId,
          target.proposalId,
          'none',
          target.language,
        );
      } catch (error) {
        logger().warn({ err: error, proposalId: target.proposalId }, 'telegram.undo_removal_failed');
      }
    })();
  }, UNDO_WINDOW_SECONDS * 1000);
  // Never the reason the process stays up.
  timer.unref();
}

/** A local wall-clock stamp for the outcome line, in the user's own timezone. */
function stampedOutcome(state: string, timezone: string, now: Date, messages: Messages): string {
  const line = messages.outcomeLines[state];
  if (line === undefined) return messages.nowState(state);
  const at = new Intl.DateTimeFormat(messages.locale, {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
  return `${line} (${at})`;
}

/**
 * Add an outcome line under the alert. The first is set off by a blank line;
 * later ones (an undo, then a second approval) stack directly beneath it, so
 * the history reads as one block rather than drifting down the message.
 */
const OUTCOME_LINES = Object.values(MESSAGES).flatMap((messages) =>
  Object.values(messages.outcomeLines).filter((line): line is string => line !== undefined),
);

export function appendOutcome(text: string, outcome: string): string {
  if (text === '') return outcome;
  const lastLine = text.slice(text.lastIndexOf('\n') + 1);
  // Any language's: the user may have switched language between two taps.
  const followsOutcome = OUTCOME_LINES.some((line) => lastLine.startsWith(line));
  return `${text}${followsOutcome ? '\n' : '\n\n'}${outcome}`;
}

/** Parse `/mute 3h`, `/mute 30m`, or bare `/mute`. Null means "not a duration". */
export function parseMuteDuration(argument: string | undefined): Date | null {
  if (argument === undefined || argument.trim() === '') {
    return new Date(Date.now() + DEFAULT_MUTE_HOURS * 3_600_000);
  }
  const match = /^(\d+)\s*([hm])$/i.exec(argument.trim());
  if (match === null) return null;
  const amount = Number(match[1]);
  const hours = match[2]!.toLowerCase() === 'h' ? amount : amount / 60;
  if (hours <= 0 || hours > MAX_MUTE_HOURS) return null;
  return new Date(Date.now() + hours * 3_600_000);
}

/**
 * Handle one update. Never throws - see the module docstring.
 *
 * `raw` is whatever Telegram sent, unparsed: an update shape we do not
 * recognise is Telegram adding a field, and it is ignored rather than refused.
 */
export async function handleTelegramUpdate(deps: UpdateDeps, raw: unknown): Promise<void> {
  const parsed = updateSchema.safeParse(raw);
  if (!parsed.success) {
    logger().info('telegram.unparsed_update');
    return;
  }
  try {
    if (parsed.data.callback_query) {
      await handleCallback(deps, parsed.data.callback_query);
    } else if (parsed.data.message) {
      await handleMessage(deps, parsed.data.message);
    }
  } catch (error) {
    logger().error({ err: error }, 'telegram.update_failed');
  }
}

function telegramOf(deps: UpdateDeps): TelegramNotifier | null {
  return deps.notifier instanceof TelegramNotifier ? deps.notifier : null;
}

async function handleMessage(
  deps: UpdateDeps,
  message: z.infer<typeof updateSchema>['message'],
): Promise<void> {
  if (!message?.text) return;
  const chatId = String(message.chat.id);
  const [command, argument] = message.text.trim().split(/\s+/, 2);
  const telegram = telegramOf(deps);

  if (command === '/start') {
    await handleStart(deps, chatId, argument, message.from?.username ?? null);
    return;
  }

  // Check two, for every command except /start: an unbound chat is ignored in
  // silence. /start is the exception because binding is precisely what it does.
  const binding = await findTelegramBindingByChat(chatId);
  if (binding === null) {
    logger().info({ chatId }, 'telegram.message_from_unbound_chat');
    return;
  }

  const settings = await getOrCreateUserSettings(binding.user_id);
  const messages = messagesFor(settings.language);

  switch (command) {
    case '/pending': {
      const open = await listProposals(binding.user_id, { open: true, limit: 10 });
      const now = new Date();
      const live = open.filter((row) => effectiveState(factsOf(row), now) !== 'expired');
      await telegram?.sendText(
        chatId,
        live.length === 0
          ? messages.nothingPending
          : live
              .map((row) => `• ${observationTextIn(row, settings.language).headline}`)
              .join('\n'),
      );
      return;
    }
    case '/mute': {
      const until = parseMuteDuration(argument);
      if (until === null) {
        await telegram?.sendText(chatId, messages.muteUsage);
        return;
      }
      await muteUntil(binding.user_id, until);
      await telegram?.sendText(chatId, messages.mutedUntil(until.toISOString()));
      return;
    }
    case '/stop': {
      await deleteTelegramBinding(binding.user_id);
      // Said explicitly, because "disconnected" could reasonably be read as
      // "stopped watching my portfolio", and it does not mean that.
      await telegram?.sendText(chatId, messages.disconnected);
      return;
    }
    case '/portfolio': {
      await telegram?.sendText(chatId, messages.alertingFrom(
          messages.severities[settings.notify_severity] ?? settings.notify_severity,
        ));
      return;
    }
    default:
      await telegram?.sendText(chatId, messages.commands);
  }
}

async function handleStart(
  deps: UpdateDeps,
  chatId: string,
  token: string | undefined,
  username: string | null,
): Promise<void> {
  const { config } = deps;
  const telegram = telegramOf(deps);
  const payload =
    token === undefined || !config.TELEGRAM_SIGNING_SECRET
      ? null
      : decodeBindToken(token, config.TELEGRAM_SIGNING_SECRET);

  if (payload === null) {
    // One message for a missing, malformed, tampered or expired link. The
    // distinctions are only useful to somebody probing, and the remedy is the
    // same for all of them.
    // English: no user is known yet, so neither is their language.
    await telegram?.sendText(chatId, messagesFor('en').linkInvalid);
    return;
  }

  const result = await redeemTelegramBindToken({
    nonce: payload.nonce,
    userId: payload.userId,
    chatId,
    username,
  });

  // The link names its user, so even a refusal can be in their language.
  const messages = messagesFor((await getOrCreateUserSettings(payload.userId)).language);
  if (result.bound) {
    await telegram?.sendText(chatId, messages.connected);
    return;
  }
  await telegram?.sendText(
    chatId,
    result.reason === 'chat_taken' ? messages.chatTaken : messages.linkUsed,
  );
}

async function handleCallback(
  deps: UpdateDeps,
  callback: NonNullable<z.infer<typeof updateSchema>['callback_query']>,
): Promise<void> {
  const { config } = deps;
  const telegram = telegramOf(deps);
  const chatId = callback.message ? String(callback.message.chat.id) : null;

  if (callback.data === BUSY_CALLBACK_DATA) {
    // The placeholder shown while an earlier tap is applied. It carries nothing
    // and decides nothing; this answer is the whole of what it does.
    // A busy tap arrives before any lookup; English, as for an unknown chat.
    await telegram?.answerCallback(callback.id, messagesFor('en').stillWorking);
    return;
  }

  if (chatId === null || callback.data === undefined || !config.TELEGRAM_SIGNING_SECRET) {
    await telegram?.answerCallback(callback.id, messagesFor('en').buttonUnusable);
    return;
  }

  // Verified before the payload is interpreted, so nothing an attacker writes
  // steers what happens next.
  const payload = decodeCallbackData(callback.data, config.TELEGRAM_SIGNING_SECRET);
  const binding = await findTelegramBindingByChat(chatId);

  if (payload === null || binding === null) {
    // Both failures answer the same way. A forwarded message reaches an unbound
    // chat and a tampered payload fails the MAC; telling them apart would only
    // help whoever is trying.
    logger().warn({ chatId, signed: payload !== null }, 'telegram.callback_rejected');
    await telegram?.answerCallback(callback.id, messagesFor('en').buttonInvalid);
    return;
  }

  const message = callback.message;
  const { language } = await getOrCreateUserSettings(binding.user_id);
  const messages = messagesFor(language);

  // The tap registered: swap every button for one inert "Approving…" before
  // doing anything slow. This is both the visible acknowledgement and the lock -
  // nothing else on the message can be pressed until the outcome is known. A
  // failure here is cosmetic and must not stop the decision the user asked for.
  if (telegram !== null && message !== undefined) {
    await telegram.showWorking(chatId, message.message_id, payload.action, language);
  }

  // The same transition the web route applies, so a tap and a click can never
  // disagree about whether the question is still open.
  const result = await applyDecision({
    userId: binding.user_id,
    proposalId: payload.proposalId,
    action: payload.action,
    surface: 'telegram',
    // Burning the nonce and applying the decision are the same write. A replay
    // loses the unique index on proposal_transitions.idempotency_key, so it
    // cannot decide twice - and it is answered with the current state rather
    // than with an error, which is what F3 asks for.
    idempotencyKey: payload.nonce,
    ...(payload.action === 'snooze'
      ? { snoozeUntil: new Date(Date.now() + TELEGRAM_SNOOZE_HOURS * 3_600_000) }
      : {}),
  });

  const reply =
    result.outcome === 'not_found'
      ? messages.proposalGone
      : result.outcome === 'refused'
        ? (refusalReply(messages, result.reason) ??
          decisionReply(messages, result.state) ??
          messages.cannotChange)
        : (decisionReply(messages, result.state) ?? messages.nowState(result.state));

  // The toast first: it is what the user is waiting on, and Telegram stops
  // spinning the button the moment it lands.
  await telegram?.answerCallback(callback.id, reply);

  if (telegram === null || message === undefined) return;

  if (result.outcome === 'not_found') {
    await telegram.setKeyboard(chatId, message.message_id, payload.proposalId, 'none', language);
    return;
  }

  if (result.outcome !== 'applied') {
    // Nothing happened, so the text gains no line - but the placeholder must
    // still go, and what replaces it is whatever the *current* state allows.
    // That is also how a stale message heals: a tap on a message whose proposal
    // was decided on the web comes back with the buttons that state really has.
    await telegram.setKeyboard(
      chatId,
      message.message_id,
      payload.proposalId,
      keyboardFor(
        result.state,
        result.state === 'approved' &&
          (await undoIsOpen(binding.user_id, payload.proposalId, new Date())),
      ),
      language,
    );
    return;
  }

  /**
   * Rewrite the message so the chat keeps a record (FLOWS.md F4).
   *
   * Each outcome is appended rather than replacing the last, so an approval
   * that was undone reads as both - which is what happened. Failure is logged
   * and swallowed: the decision is already in the ledger, and a message that
   * could not be rewritten is a cosmetic loss.
   */
  const user = await getUser(binding.user_id);
  const outcome = stampedOutcome(result.state, user?.timezone ?? 'UTC', new Date(), messages);
  const edited = await telegram.editMessage(
    chatId,
    message.message_id,
    appendOutcome(message.text ?? '', outcome),
    // A decision that has just been applied as an approval is, by definition,
    // at the start of its undo window.
    { proposalId: payload.proposalId, keyboard: keyboardFor(result.state, true), language },
  );
  if (result.state === 'approved') {
    scheduleUndoRemoval(telegram, {
      userId: binding.user_id,
      proposalId: payload.proposalId,
      chatId,
      messageId: message.message_id,
      language,
    });
  }
  if (!edited.delivered) {
    logger().warn(
      { chatId, messageId: message.message_id, err: edited.error },
      'telegram.edit_failed',
    );
  }
}
