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
import { decideProposal } from '../mastra/proposalLifecycle.js';
import type { Notifier } from '../notify/notifier.js';
import {
  effectiveState,
  undoableUntil,
  UNDO_WINDOW_SECONDS,
  type RefusalReason,
} from '../services/proposalState.js';
import { factsOf } from '../services/proposals.js';
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

/** What the user is told after a tap. One line each; the chat is not a UI. */
const DECISION_REPLIES: Record<string, string> = {
  approved: 'Approved ✓ — recorded in your ledger. No order was placed.',
  pending: 'Approval undone ✓ — the question is open again.',
  rejected: 'Rejected ✓',
  snoozed: `Snoozed for ${TELEGRAM_SNOOZE_HOURS}h`,
  expired: 'This has expired — open the app for the refreshed view.',
};

/**
 * Refusals that need their own words. Everything else is answered with the
 * state the proposal is actually in, which is the more useful half of a "no".
 */
const REFUSAL_REPLIES: Partial<Record<RefusalReason, string>> = {
  not_undoable: 'Only an approval can be undone.',
  already_decided: 'This was already decided — open the app to see how.',
  undo_window_closed: `Too late to undo — approvals can be undone for ${UNDO_WINDOW_SECONDS} seconds.`,
};

/**
 * The line appended to the message itself once a decision is in.
 *
 * Separate from DECISION_REPLIES because the two are read at different moments.
 * The reply is a toast the user sees now; this is what they find when they
 * scroll back tomorrow - so it records what happened and when, rather than
 * confirming an action they have just taken.
 */
const OUTCOME_LINES: Record<string, string> = {
  approved: '\u2705 Approved \u2014 recorded in your ledger. No order was placed.',
  rejected: '\u274c Rejected',
  snoozed: '\u23f8 Snoozed \u2014 still open; decide any time before it expires',
  expired: '\u23f3 Expired \u2014 no longer answerable',
  pending: '\u21a9 Approval undone \u2014 open again; nothing remains in your ledger',
};

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
  target: { userId: string; proposalId: string; chatId: string; messageId: number },
): void {
  const timer = setTimeout(() => {
    void (async () => {
      try {
        const row = await findProposal(target.userId, target.proposalId);
        if (row === null || effectiveState(factsOf(row), new Date()) !== 'approved') return;
        await telegram.setKeyboard(target.chatId, target.messageId, target.proposalId, 'none');
      } catch (error) {
        logger().warn({ err: error, proposalId: target.proposalId }, 'telegram.undo_removal_failed');
      }
    })();
  }, UNDO_WINDOW_SECONDS * 1000);
  // Never the reason the process stays up.
  timer.unref();
}

/** A local wall-clock stamp for the outcome line, in the user's own timezone. */
function stampedOutcome(state: string, timezone: string, now: Date): string {
  const line = OUTCOME_LINES[state];
  if (line === undefined) return `Now ${state}.`;
  const at = new Intl.DateTimeFormat('en-GB', {
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
export function appendOutcome(text: string, outcome: string): string {
  if (text === '') return outcome;
  const lastLine = text.slice(text.lastIndexOf('\n') + 1);
  const followsOutcome = Object.values(OUTCOME_LINES).some((line) => lastLine.startsWith(line));
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

  switch (command) {
    case '/pending': {
      const open = await listProposals(binding.user_id, { open: true, limit: 10 });
      const now = new Date();
      const live = open.filter((row) => effectiveState(factsOf(row), now) !== 'expired');
      await telegram?.sendText(
        chatId,
        live.length === 0
          ? 'Nothing waiting on you.'
          : live.map((row) => `• ${row.headline}`).join('\n'),
      );
      return;
    }
    case '/mute': {
      const until = parseMuteDuration(argument);
      if (until === null) {
        await telegram?.sendText(chatId, 'Try /mute 2h or /mute 30m.');
        return;
      }
      await muteUntil(binding.user_id, until);
      await telegram?.sendText(
        chatId,
        `Muted until ${until.toISOString()}. Findings still reach your feed and the digest.`,
      );
      return;
    }
    case '/stop': {
      await deleteTelegramBinding(binding.user_id);
      // Said explicitly, because "disconnected" could reasonably be read as
      // "stopped watching my portfolio", and it does not mean that.
      await telegram?.sendText(
        chatId,
        'Disconnected. Your portfolio is still being watched; nothing will be sent here.',
      );
      return;
    }
    case '/portfolio': {
      const settings = await getOrCreateUserSettings(binding.user_id);
      await telegram?.sendText(
        chatId,
        `Alerting on ${settings.notify_severity} and above. Open the app for the full portfolio.`,
      );
      return;
    }
    default:
      await telegram?.sendText(chatId, 'Commands: /portfolio /pending /mute /stop');
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
    await telegram?.sendText(chatId, 'That link is not valid or has expired. Generate a new one.');
    return;
  }

  const result = await redeemTelegramBindToken({
    nonce: payload.nonce,
    userId: payload.userId,
    chatId,
    username,
  });

  if (result.bound) {
    await telegram?.sendText(chatId, 'Connected. Alerts will arrive here.');
    return;
  }
  await telegram?.sendText(
    chatId,
    result.reason === 'chat_taken'
      ? 'This chat is already connected to another account.'
      : 'That link has already been used. Generate a new one.',
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
    await telegram?.answerCallback(callback.id, 'Still working on it\u2026');
    return;
  }

  if (chatId === null || callback.data === undefined || !config.TELEGRAM_SIGNING_SECRET) {
    await telegram?.answerCallback(callback.id, 'This button is no longer usable.');
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
    await telegram?.answerCallback(callback.id, 'This button is not valid for this chat.');
    return;
  }

  const message = callback.message;

  // The tap registered: swap every button for one inert "Approving…" before
  // doing anything slow. This is both the visible acknowledgement and the lock -
  // nothing else on the message can be pressed until the outcome is known. A
  // failure here is cosmetic and must not stop the decision the user asked for.
  if (telegram !== null && message !== undefined) {
    await telegram.showWorking(chatId, message.message_id, payload.action);
  }

  // Through the workflow, exactly as the web route does. Calling the service
  // directly would apply the decision and leave the run suspended on it until
  // the next sweep - the one path in the product where the lifecycle and the
  // proposal disagreed about whether the question was still open.
  const result = await decideProposal({
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
      ? 'That proposal no longer exists.'
      : result.outcome === 'refused'
        ? (REFUSAL_REPLIES[result.reason] ??
          DECISION_REPLIES[result.state] ??
          'That can no longer be changed.')
        : (DECISION_REPLIES[result.state] ?? `Now ${result.state}.`);

  // The toast first: it is what the user is waiting on, and Telegram stops
  // spinning the button the moment it lands.
  await telegram?.answerCallback(callback.id, reply);

  if (telegram === null || message === undefined) return;

  if (result.outcome === 'not_found') {
    await telegram.setKeyboard(chatId, message.message_id, payload.proposalId, 'none');
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
  const outcome = stampedOutcome(result.state, user?.timezone ?? 'UTC', new Date());
  const edited = await telegram.editMessage(
    chatId,
    message.message_id,
    appendOutcome(message.text ?? '', outcome),
    // A decision that has just been applied as an approval is, by definition,
    // at the start of its undo window.
    { proposalId: payload.proposalId, keyboard: keyboardFor(result.state, true) },
  );
  if (result.state === 'approved') {
    scheduleUndoRemoval(telegram, {
      userId: binding.user_id,
      proposalId: payload.proposalId,
      chatId,
      messageId: message.message_id,
    });
  }
  if (!edited.delivered) {
    logger().warn(
      { chatId, messageId: message.message_id, err: edited.error },
      'telegram.edit_failed',
    );
  }
}
