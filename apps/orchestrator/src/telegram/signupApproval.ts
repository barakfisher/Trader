/**
 * The admin's sign-up request message in Telegram, and its buttons (D156,
 * D184, D187, D188).
 *
 * A new request is announced to every active admin's bound chat with *Approve*
 * and *Reject*. There is no amount to choose: a user runs on their own key only
 * (D245), and the retired monthly cap (D279) is written with the installation's
 * default only to keep its column's CHECK satisfied. The signed button still
 * carries that figure, so a button sent before D279 decodes as before; its
 * *Custom budget* button now shows the two buttons again.
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
import type { EmailSender } from '../email/sender.js';
import { announceSignupApproved } from '../http/accountMail.js';
import { logger } from '../logger.js';
import { messagesFor, type Messages } from '../notify/messages.js';
import type { Notifier } from '../notify/notifier.js';
import { TelegramNotifier, type InlineKeyboard } from './client.js';
import { encodeSignupData, type SignupPayload } from './signupToken.js';

type SignupButtons = 'decide' | 'none';

function keyboard(
  which: SignupButtons,
  userId: string,
  retiredCapMicroUsd: number,
  messages: Messages,
  secret: string,
): InlineKeyboard {
  const button = (payload: SignupPayload, text: string) => ({
    text,
    callback_data: encodeSignupData(payload, secret),
  });
  switch (which) {
    case 'decide':
      return [
        [
          button({ userId, action: 'approve', capMicroUsd: retiredCapMicroUsd }, messages.signup.buttons.approve),
          button({ userId, action: 'reject' }, messages.signup.buttons.reject),
        ],
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
        keyboard('decide', userId, settings.default_llm_cap_micro_usd, messages, deps.signingSecret),
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
  /** The approved person is mailed (D344); null on an installation without mail. */
  email: EmailSender | null;
  /** The approval mail's link base: the first entry (`accountMail.ts`). */
  allowedOrigins: readonly string[];
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
    // A *Custom budget* button from before D279: there is no amount to choose now.
    const request = await getSignupRequest(payload.userId);
    if (request?.status !== 'pending') {
      // A request approved and since closed (D264) reads as approved.
      await healed({ status: request?.status === 'closed' ? 'active' : (request?.status ?? 'gone') });
      return;
    }
    await telegram?.answerCallback(callback.callbackId, messages.signup.already.pending);
    if (telegram !== null && message !== undefined) {
      const { default_llm_cap_micro_usd: retiredCap } = await getInstallationSettings();
      await telegram.setButtons(
        chatId,
        message.message_id,
        keyboard('decide', payload.userId, retiredCap, messages, callback.signingSecret),
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
  // Before anything Telegram does: a failed toast or edit must not cost the person their mail (D344).
  if (payload.action === 'approve') {
    announceSignupApproved(callback.email, callback.allowedOrigins, { id: payload.userId, email: decision.email });
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
      ? messages.signup.approvedLine(at)
      : messages.signup.rejectedLine(at);
  const edited = await telegram.editWithButtons(
    chatId,
    message.message_id,
    message.text ? `${message.text}\n\n${line}` : line,
    [],
  );
  if (!edited.delivered) logger().warn({ chatId, err: edited.error }, 'telegram.edit_failed');
}
