/**
 * The Telegram webhook and the "Connect Telegram" endpoint (FLOWS.md F4).
 *
 * This is a **public, unauthenticated endpoint** - anybody who learns the URL
 * can post to it - so nothing here trusts its input. Three checks stand between
 * an inbound update and any effect on the ledger, and each is independent:
 *
 *   1. **The secret header.** Telegram echoes `X-Telegram-Bot-Api-Secret-Token`
 *      on every delivery. A request without it never reaches the parsing below.
 *   2. **The chat binding.** An unbound chat is ignored *in silence* (F4) -
 *      replying would confirm the bot exists to whoever found it, and there is
 *      nothing useful to say to a stranger.
 *   3. **The signed callback, and its nonce.** A forwarded message keeps working
 *      buttons, so the payload carries an HMAC and a single-use nonce. The nonce
 *      is burned by the unique index on `proposal_transitions.idempotency_key`,
 *      which means a replay loses a database race rather than passing a check -
 *      there is no window between testing and spending.
 *
 * **The webhook always answers 200.** Telegram retries anything else, and a
 * retry re-delivers a callback whose nonce is already spent - so a 500 here
 * converts one failure into a loop. Errors are logged and swallowed; the user
 * hears about them through the callback answer, which is where they can act.
 */

import type { Context as HonoContext, Hono } from 'hono';
import { z } from 'zod';

import {
  deleteTelegramBinding,
  findTelegramBindingByChat,
  findTelegramBindingByUser,
  getOrCreateUserSettings,
  getUser,
  listProposals,
  muteUntil,
  redeemTelegramBindToken,
} from '../db/queries.js';
import { logger } from '../logger.js';
import { applyDecision } from '../services/proposals.js';
import { effectiveState } from '../services/proposalState.js';
import { factsOf } from '../services/proposals.js';
import { currentUserId, type AppEnv } from '../http/app.js';
import { decodeBindToken, encodeBindToken } from './bindToken.js';
import { decodeCallbackData, type CallbackAction } from './callbackToken.js';
import { TelegramNotifier } from './client.js';

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
  rejected: 'Rejected ✓',
  snoozed: `Snoozed for ${TELEGRAM_SNOOZE_HOURS}h`,
  expired: 'This has expired — open the app for the refreshed view.',
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
};

/** States the user can still act on. Their buttons stay; every other state loses them. */
const STILL_ANSWERABLE = new Set(['pending', 'snoozed']);

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

export function registerTelegramRoutes(app: Hono<AppEnv>): void {
  /**
   * Mint a connect link. Authenticated, because it names the user it binds -
   * this is the one Telegram endpoint that is *not* public, and it is the only
   * place a token is created.
   */
  app.post('/telegram/bind-token', async (context) => {
    const config = context.get('config');
    if (!config.TELEGRAM_BOT_USERNAME || !config.TELEGRAM_WEBHOOK_SECRET) {
      return context.json(
        { error: 'telegram_not_configured', message: 'this installation has no Telegram bot' },
        503,
      );
    }
    const { token, payload } = encodeBindToken(
      currentUserId(context),
      config.TELEGRAM_WEBHOOK_SECRET,
    );
    return context.json({
      // The deep link, ready to render as a button or a QR code.
      url: `https://t.me/${config.TELEGRAM_BOT_USERNAME}?start=${token}`,
      expiresAt: payload.expiresAt.toISOString(),
    });
  });

  /** Whether this user has a chat connected, for the settings page to show. */
  app.get('/telegram/binding', async (context) => {
    const binding = await findTelegramBindingByUser(currentUserId(context));
    return context.json({
      connected: binding !== null,
      username: binding?.username ?? null,
      boundAt: binding?.bound_at.toISOString() ?? null,
    });
  });

  app.post('/telegram/webhook', async (context) => {
    const config = context.get('config');
    const secret = config.TELEGRAM_WEBHOOK_SECRET;

    // Check one. Compared before the body is even read: an unauthenticated
    // caller must not be able to make us parse anything.
    if (!secret || context.req.header('x-telegram-bot-api-secret-token') !== secret) {
      logger().warn('telegram.webhook_bad_secret');
      // 401 rather than a silent 200: this is not Telegram, so there is no
      // retry storm to avoid, and a caller guessing the URL learns nothing from
      // a status they could have got by guessing the secret too.
      return context.json({ ok: false }, 401);
    }

    const parsed = updateSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      // Ignored, not rejected: an update shape we do not recognise is Telegram
      // adding a field, and answering non-200 would have it redelivered forever.
      logger().info('telegram.webhook_unparsed_update');
      return context.json({ ok: true });
    }

    try {
      if (parsed.data.callback_query) {
        await handleCallback(context, parsed.data.callback_query);
      } else if (parsed.data.message) {
        await handleMessage(context, parsed.data.message);
      }
    } catch (error) {
      // Always 200. See the module docstring: a 500 turns one failure into a
      // redelivery loop against nonces that are already spent.
      logger().error({ err: error }, 'telegram.webhook_failed');
    }
    return context.json({ ok: true });
  });
}

/** The request context these handlers read config and the notifier from. */
type Context = HonoContext<AppEnv>;

function notifierFor(context: Context): TelegramNotifier | null {
  const notifier = context.get('notifier');
  return notifier instanceof TelegramNotifier ? notifier : null;
}

async function handleMessage(
  context: Context,
  message: z.infer<typeof updateSchema>['message'],
): Promise<void> {
  if (!message?.text) return;
  const chatId = String(message.chat.id);
  const [command, argument] = message.text.trim().split(/\s+/, 2);
  const telegram = notifierFor(context);

  if (command === '/start') {
    await handleStart(context, chatId, argument, message.from?.username ?? null);
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
  context: Context,
  chatId: string,
  token: string | undefined,
  username: string | null,
): Promise<void> {
  const config = context.get('config');
  const telegram = notifierFor(context);
  const payload =
    token === undefined || !config.TELEGRAM_WEBHOOK_SECRET
      ? null
      : decodeBindToken(token, config.TELEGRAM_WEBHOOK_SECRET);

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
  context: Context,
  callback: NonNullable<z.infer<typeof updateSchema>['callback_query']>,
): Promise<void> {
  const config = context.get('config');
  const telegram = notifierFor(context);
  const chatId = callback.message ? String(callback.message.chat.id) : null;

  if (chatId === null || callback.data === undefined || !config.TELEGRAM_CALLBACK_SECRET) {
    await telegram?.answerCallback(callback.id, 'This button is no longer usable.');
    return;
  }

  // Check three: the signature. Verified before the payload is interpreted, so
  // nothing an attacker writes steers what happens next.
  const payload = decodeCallbackData(callback.data, config.TELEGRAM_CALLBACK_SECRET);
  const binding = await findTelegramBindingByChat(chatId);

  if (payload === null || binding === null) {
    // Both failures answer the same way. A forwarded message reaches an unbound
    // chat and a tampered payload fails the MAC; telling them apart would only
    // help whoever is trying.
    logger().warn({ chatId, signed: payload !== null }, 'telegram.callback_rejected');
    await telegram?.answerCallback(callback.id, 'This button is not valid for this chat.');
    return;
  }

  const result = await applyDecision({
    userId: binding.user_id,
    proposalId: payload.proposalId,
    action: payload.action as CallbackAction,
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
        ? (DECISION_REPLIES[result.state] ?? 'That can no longer be changed.')
        : (DECISION_REPLIES[result.state] ?? `Now ${result.state}.`);

  // The toast first: it is what the user is waiting on, and Telegram stops
  // spinning the button the moment it lands. The edit below is slower and
  // matters later, so it must not delay this.
  await telegram?.answerCallback(callback.id, reply);

  if (result.outcome === 'not_found') return;

  /**
   * Rewrite the message so the chat keeps a record (FLOWS.md F4).
   *
   * Without this the alert sits in the history for ever with three live-looking
   * buttons and nothing saying what was decided - the exact staleness the web
   * inbox re-renders to avoid. `answerCallbackQuery` cannot serve here: it is a
   * toast that vanishes in a second and leaves nothing behind.
   *
   * Failure is logged and swallowed, like the toast. The decision is already
   * applied and in the ledger; a message that could not be rewritten is a
   * cosmetic loss, and throwing would hand Telegram a non-200 and earn a
   * redelivery of a callback whose nonce is already spent.
   */
  const original = callback.message?.text;
  if (telegram === null || callback.message === undefined || original === undefined) return;

  const user = await getUser(binding.user_id);
  const outcome = stampedOutcome(result.state, user?.timezone ?? 'UTC', new Date());
  const edited = await telegram.editMessage(
    chatId,
    callback.message.message_id,
    `${original}\n\n${outcome}`,
    // A snooze is "not now", not a decision: the user may still approve before
    // the deadline, so its buttons stay. Everything else here is terminal.
    { keepButtons: STILL_ANSWERABLE.has(result.state) },
  );
  if (!edited.delivered) {
    logger().warn(
      { chatId, messageId: callback.message.message_id, err: edited.error },
      'telegram.edit_failed',
    );
  }
}
