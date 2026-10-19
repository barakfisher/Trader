/**
 * The admin's sign-up request message in Telegram, and its buttons (D156,
 * D184, D187, D188).
 *
 * A new request is announced to every active admin's bound chat with *Approve
 * at the default cap*, *Custom budget* and *Reject*. *Custom budget* swaps the
 * buttons for preset amounts and a link to the Admin page for any other - the
 * amount rides in the signed button, so the bot keeps no conversation state.
 *
 * The page and the chat apply the same conditional transitions
 * (`queries/signups.ts`). A message decided on the page keeps its buttons until
 * tapped; the tap then answers with where the request is now and takes them
 * away, as a stale proposal message heals (`updates.ts`).
 */

import {
  approveSignup,
  getInstallationSettings,
  getSignupRequest,
  getUser,
  insertAdminAudit,
  isActiveAdmin,
  listAdminChats,
  rejectSignup,
  type SignupDecision,
} from '../db/queries.js';
import { logger } from '../logger.js';
import { messagesFor, type Messages } from '../notify/messages.js';
import type { Notifier } from '../notify/notifier.js';
import { TelegramNotifier, type InlineKeyboard } from './client.js';
import { encodeSignupData, type SignupPayload } from './signupToken.js';

/** What *Custom budget* offers (D184): $5, $20, $50 a month. */
export const PRESET_CAPS_MICRO_USD = [5_000_000, 20_000_000, 50_000_000] as const;

/** A cap in dollars, in the admin's locale: whole dollars bare, anything else to the cent. */
export function formatCap(microUsd: number, messages: Messages): string {
  const whole = microUsd % 1_000_000 === 0;
  return new Intl.NumberFormat(messages.numberLocale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(microUsd / 1_000_000);
}

type SignupButtons = 'decide' | 'amounts' | 'none';

function keyboard(
  which: SignupButtons,
  userId: string,
  defaultCapMicroUsd: number,
  messages: Messages,
  secret: string,
  linkBase: string | null,
): InlineKeyboard {
  const button = (payload: SignupPayload, text: string) => ({
    text,
    callback_data: encodeSignupData(payload, secret),
  });
  const reject = button({ userId, action: 'reject' }, messages.signup.buttons.reject);
  switch (which) {
    case 'decide':
      return [
        [
          button(
            { userId, action: 'approve', capMicroUsd: defaultCapMicroUsd },
            messages.signup.buttons.approveDefault(formatCap(defaultCapMicroUsd, messages)),
          ),
        ],
        [button({ userId, action: 'custom' }, messages.signup.buttons.custom), reject],
      ];
    case 'amounts':
      return [
        PRESET_CAPS_MICRO_USD.map((cap) =>
          button({ userId, action: 'approve', capMicroUsd: cap }, messages.signup.buttons.amount(formatCap(cap, messages))),
        ),
        ...(linkBase === null ? [] : [[{ text: messages.signup.buttons.otherAmount, url: `${linkBase}/admin` }]]),
        [reject],
      ];
    case 'none':
      return [];
  }
}

export interface AnnounceDeps {
  notifier: Notifier;
  signingSecret: string | undefined;
}

/**
 * Tell every admin about a new request. Never throws: the request is already
 * written and waits on the Admin page whatever happens here, so a failed send
 * is logged, not refused to the person signing up.
 */
export async function announceSignupRequest(deps: AnnounceDeps, userId: string): Promise<void> {
  try {
    const telegram = deps.notifier instanceof TelegramNotifier ? deps.notifier : null;
    if (telegram === null || !deps.signingSecret) {
      logger().info({ userId }, 'signup.announce_skipped_no_telegram');
      return;
    }
    const [request, settings, chats] = await Promise.all([
      getSignupRequest(userId),
      getInstallationSettings(),
      listAdminChats(),
    ]);
    if (request === null || request.status !== 'pending') return;
    if (chats.length === 0) logger().info({ userId }, 'signup.announce_skipped_no_admin_chat');
    for (const chat of chats) {
      const messages = messagesFor(chat.language);
      const sent = await telegram.sendWithButtons(
        chat.chat_id,
        messages.signup.request(request.email ?? '', request.timezone),
        keyboard('decide', userId, settings.default_llm_cap_micro_usd, messages, deps.signingSecret, telegram.linkBase),
      );
      if (!sent.delivered) logger().warn({ userId, err: sent.error }, 'signup.announce_failed');
    }
  } catch (error) {
    logger().error({ err: error, userId }, 'signup.announce_failed');
  }
}

export interface SignupCallback {
  telegram: TelegramNotifier | null;
  signingSecret: string;
  /** The bound chat's user: must be an active admin. */
  userId: string;
  language: string;
  callbackId: string;
  chatId: string;
  message?: { message_id: number; text?: string };
  payload: SignupPayload;
}

function stamp(timezone: string, messages: Messages): string {
  return new Intl.DateTimeFormat(messages.locale, {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date());
}

/** A tap on a sign-up button. Never throws to the caller (`updates.ts`). */
export async function handleSignupCallback(callback: SignupCallback): Promise<void> {
  const { telegram, payload, message, chatId } = callback;
  const messages = messagesFor(callback.language);

  // A forwarded request in an ordinary user's chat is answered as any invalid
  // button is: the binding is the authority, never the message.
  if (!(await isActiveAdmin(callback.userId))) {
    logger().warn({ chatId }, 'telegram.signup_callback_not_admin');
    await telegram?.answerCallback(callback.callbackId, messages.buttonInvalid);
    return;
  }

  const healed = async (decision: { status: SignupDecision['status'] }) => {
    await telegram?.answerCallback(callback.callbackId, messages.signup.already[decision.status]);
    if (telegram !== null && message !== undefined && decision.status !== 'pending') {
      await telegram.setButtons(chatId, message.message_id, []);
    }
  };

  if (payload.action === 'custom') {
    const request = await getSignupRequest(payload.userId);
    if (request?.status !== 'pending') {
      await healed({ status: request?.status ?? 'gone' });
      return;
    }
    const linkBase = telegram?.linkBase ?? null;
    await telegram?.answerCallback(
      callback.callbackId,
      linkBase === null
        ? `${messages.signup.chooseAmountToast} ${messages.signup.otherAmountInApp}`
        : messages.signup.chooseAmountToast,
    );
    if (telegram !== null && message !== undefined) {
      const { default_llm_cap_micro_usd: defaultCap } = await getInstallationSettings();
      await telegram.setButtons(
        chatId,
        message.message_id,
        keyboard('amounts', payload.userId, defaultCap, messages, callback.signingSecret, linkBase),
      );
    }
    return;
  }

  // Audited before it applies, as the Admin page's gate does (decision 84).
  await insertAdminAudit({
    adminUserId: callback.userId,
    action: `telegram signup ${payload.action}`,
    detail: payload,
    ipAddress: null,
    requestId: `telegram:${callback.callbackId}`,
  });
  const decision =
    payload.action === 'approve'
      ? await approveSignup(payload.userId, payload.capMicroUsd, callback.userId)
      : await rejectSignup(payload.userId);
  if (!decision.applied) {
    await healed(decision);
    return;
  }

  await telegram?.answerCallback(
    callback.callbackId,
    payload.action === 'approve' ? messages.signup.approvedToast : messages.signup.rejectedToast,
  );
  if (telegram === null || message === undefined) return;
  const admin = await getUser(callback.userId);
  const at = stamp(admin?.timezone ?? 'UTC', messages);
  const line =
    payload.action === 'approve'
      ? messages.signup.approvedLine(formatCap(payload.capMicroUsd, messages), at)
      : messages.signup.rejectedLine(at);
  const edited = await telegram.editWithButtons(
    chatId,
    message.message_id,
    message.text ? `${message.text}\n\n${line}` : line,
    [],
  );
  if (!edited.delivered) logger().warn({ chatId, err: edited.error }, 'telegram.edit_failed');
}
