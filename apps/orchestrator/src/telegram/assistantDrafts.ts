/**
 * A proposal the assistant drafted, in Telegram (D393): its own message under the
 * answer, because a message has one keyboard and the answer's holds the suggested
 * questions. Nothing is written until the user taps Add to proposals.
 *
 * The language is the draft's own - its reason is in the question's - so the frame
 * around the model's words never differs from them.
 */

import { writtenLanguage, type AssistantProposalDraftView } from '@traders/shared';

import { logger } from '../logger.js';
import { messagesFor, type Messages } from '../notify/messages.js';
import { addDraftToProposals, closeDraft } from '../services/assistantProposals.js';
import { encodeAssistantDraftData, type AssistantDraftPayload } from './assistantDraftToken.js';
import type { TelegramNotifier } from './client.js';

type DraftText = Pick<AssistantProposalDraftView, 'action' | 'symbol' | 'reason'>;

/** The draft as a message: the catalogue's frame, and the not-advice line last, always (D385). */
export function draftText(draft: DraftText, messages: Messages, outcome?: string): string {
  return [
    messages.assistantProposalHeadline(draft.action, draft.symbol),
    draft.reason,
    messages.assistantAcknowledgeOnly,
    ...(outcome === undefined ? [] : [outcome]),
    messages.assistantNotAdvice,
  ].join('\n\n');
}

export async function sendDraft(
  telegram: TelegramNotifier,
  chatId: string,
  messageId: string,
  draft: DraftText,
  signingSecret: string,
): Promise<void> {
  const messages = messagesFor(writtenLanguage(draft.reason));
  const button = (action: AssistantDraftPayload['action'], text: string) => ({
    text,
    callback_data: encodeAssistantDraftData({ messageId, action }, signingSecret),
  });
  await telegram.sendWithButtons(chatId, draftText(draft, messages), [
    [button('add', messages.assistantDraft.add), button('close', messages.assistantDraft.close)],
  ]);
}

function outcomeLine(draft: AssistantProposalDraftView, messages: Messages): string {
  if (draft.alreadyOpen) return messages.assistantDraft.alreadyOpen;
  return messages.assistantDraft[draft.state === 'open' ? 'expired' : draft.state];
}

/** A tap: the buttons go, and the message says what became of the draft. */
export async function handleDraftTap(input: {
  telegram: TelegramNotifier;
  callbackId: string;
  chatId: string;
  telegramMessageId: number;
  userId: string;
  /** The user's language, for a tap that finds no draft to take one from. */
  language: string;
  payload: AssistantDraftPayload;
}): Promise<void> {
  const { telegram, callbackId, chatId, telegramMessageId, userId, language, payload } = input;
  const draft =
    payload.action === 'add'
      ? await addDraftToProposals(userId, payload.messageId)
      : await closeDraft(userId, payload.messageId);
  if (draft === null) {
    // Another user's draft, a deleted conversation, or a user who may not have one.
    logger().warn({ chatId, messageId: payload.messageId }, 'telegram.assistant_draft_rejected');
    await telegram.answerCallback(callbackId, messagesFor(language).buttonInvalid);
    return;
  }
  const messages = messagesFor(writtenLanguage(draft.reason));
  const line = outcomeLine(draft, messages);
  await telegram.answerCallback(callbackId, line);
  await telegram.editWithButtons(chatId, telegramMessageId, draftText(draft, messages, line), []);
}
