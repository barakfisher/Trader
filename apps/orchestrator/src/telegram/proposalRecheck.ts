/**
 * *Re-check* from Telegram (D217): the one button an expired trade proposal's
 * message gets, once a tap finds it expired (we keep no message ids, so nothing
 * swaps the buttons at the deadline itself).
 *
 * A re-check is a model call of up to a minute, and the poller handles updates
 * one at a time, so the tap is answered at once - "re-checking" - and the work
 * runs on. What it came to is appended under the message, as every decision's
 * outcome is: a new proposal arrives as its own message with Approve and Reject
 * (`proposeFromScan` announces it), so the line here only says one follows; a
 * refusal says why in the user's language (D214); a re-check that reached no
 * answer keeps the button, because it did not use the refresh up (D213).
 *
 * Replay needs no nonce: "once" is the database's (`agent_scans_one_refresh`),
 * and a second tap meets `already_rechecked` before any model is called.
 */

import type { RecheckResult } from '@traders/shared';
import type { AiClient } from '@traders/shared/ai';

import { findProposal, getUser } from '../db/queries.js';
import { ApiProblem } from '../http/errors.js';
import { logger } from '../logger.js';
import { messagesFor, type Messages } from '../notify/messages.js';
import type { Notifier } from '../notify/notifier.js';
import { recheckProposal, recheckStatus } from '../services/proposalRecheck.js';
import type { CallbackPayload } from './callbackToken.js';
import type { TelegramNotifier } from './client.js';

export interface RecheckCallback {
  telegram: TelegramNotifier | null;
  ai: AiClient;
  notifier: Notifier;
  userId: string;
  language: string;
  callbackId: string;
  chatId: string;
  message?: { message_id: number; text?: string };
  payload: CallbackPayload & { action: 'recheck' };
  now?: () => Date;
}

function refusalOf(code: string, messages: Messages): string {
  return (messages.recheck.refusals as Record<string, string | undefined>)[code] ?? messages.recheck.refusals.other;
}

function stamp(now: Date, timezone: string, messages: Messages): string {
  return new Intl.DateTimeFormat(messages.locale, {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
}

/** Whether an expired trade proposal may be re-checked now (D215, D217), read fresh. */
export async function recheckOffered(userId: string, proposalId: string): Promise<boolean> {
  try {
    const row = await findProposal(userId, proposalId);
    return row !== null && (await recheckStatus(userId, row, new Date()))?.blocked === null;
  } catch (error) {
    // Only a button: the expiry it is offered beside must still be said.
    logger().warn({ err: error, proposalId }, 'telegram.recheck_offer_unknown');
    return false;
  }
}

/** The line a finished re-check adds under the message. */
export function recheckLine(result: RecheckResult, at: string, messages: Messages): string {
  switch (result.outcome) {
    case 'proposed':
      return messages.recheck.proposed(at);
    case 'declined':
      return messages.recheck.declined(
        at,
        result.reason.kind === 'agent'
          ? messages.recheck.agentSaid(result.reason.thesis)
          : messages.recheck.checks[result.reason.check],
      );
    case 'unanswered':
      return messages.recheck.unanswered(at, messages.recheck.causes[result.cause]);
    case 'running':
      return messages.recheck.refusals.scan_running;
  }
}

/**
 * Answer the tap, and start the re-check when it may run. `done` settles when
 * the re-check has and the message says so; the caller does not wait for it.
 */
export async function startRecheckCallback(input: RecheckCallback): Promise<{ done: Promise<void> }> {
  const { telegram, userId, payload, message, chatId, language } = input;
  const messages = messagesFor(language);
  const clock = input.now ?? (() => new Date());
  const row = await findProposal(userId, payload.proposalId);
  const status = row === null ? null : await recheckStatus(userId, row, clock());

  if (status === null || status.blocked !== null) {
    const toast = status === null ? messages.proposalGone : refusalOf(status.blocked!, messages);
    await telegram?.answerCallback(input.callbackId, toast);
    // A message that cannot be re-checked keeps no button; one that is running keeps its placeholder.
    if (telegram !== null && message !== undefined && status?.blocked !== 'scan_running') {
      await telegram.setKeyboard(chatId, message.message_id, payload.proposalId, 'none', language);
    }
    return { done: Promise.resolve() };
  }

  if (telegram !== null && message !== undefined) {
    await telegram.showWorking(chatId, message.message_id, 'recheck', language);
  }
  await telegram?.answerCallback(input.callbackId, messages.recheck.startedToast);
  return { done: finish(input, messages, clock).catch((error: unknown) => {
    logger().error({ err: error, proposalId: payload.proposalId }, 'telegram.recheck_failed');
  }) };
}

async function finish(input: RecheckCallback, messages: Messages, clock: () => Date): Promise<void> {
  const { telegram, userId, payload, message, chatId, language } = input;
  let line: string;
  let keyboard: 'recheck' | 'none';
  try {
    const result = await recheckProposal(userId, payload.proposalId, {
      ai: input.ai,
      notifier: input.notifier,
      now: clock,
    });
    const timezone = (await getUser(userId))?.timezone ?? 'UTC';
    line = recheckLine(result, stamp(clock(), timezone, messages), messages);
    keyboard = result.outcome === 'unanswered' ? 'recheck' : 'none';
  } catch (error) {
    if (!(error instanceof ApiProblem)) throw error;
    // Refused before any model call: the refresh is not used up unless that is the reason.
    line = refusalOf(error.code, messages);
    keyboard =
      error.code === 'already_rechecked' || error.code === 'superseded' || error.status === 404 ? 'none' : 'recheck';
  }
  if (telegram === null || message === undefined) return;
  const text = message.text ?? '';
  const edited = await telegram.editMessage(chatId, message.message_id, text === '' ? line : `${text}\n\n${line}`, {
    proposalId: payload.proposalId,
    keyboard,
    language,
  });
  if (!edited.delivered) {
    logger().warn({ chatId, messageId: message.message_id, err: edited.error }, 'telegram.edit_failed');
  }
}
