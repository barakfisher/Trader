/**
 * A question written to the bot, answered by the assistant (D221-D224).
 *
 * **The Ask page's call, not a copy of it.** The question goes to the AI
 * service's `POST /assistant/messages` with the bound user, exactly as the Ask
 * page's does, so the daily allowance, the monthly cap and the user's own key
 * apply to it unchanged - and the conversation it lands in is an ordinary one,
 * listed on the Ask page.
 *
 * **One rolling conversation per chat** (D222): the binding names it, and a
 * question joins it until it has been quiet for `QUIET_HOURS`, or `/new` clears
 * it. Each question sends only the conversation's last few messages to the
 * model (`service.py`'s `HISTORY_MESSAGES`), so a long one costs no more.
 *
 * **Answered off the poller.** An answer takes seconds, at worst two minutes
 * (`TIME_LIMIT`), and the poller handles one update at a time - a button tap
 * behind a question would wait for it. So the question is started and left to
 * finish, as a re-check is (`proposalRecheck.ts`); "typing…" shows meanwhile.
 * One question per chat at a time: a second, sent before the first is answered,
 * is refused rather than queued, because its answer would be written without
 * the first one's in the conversation. The guard is in-process, as the poller
 * is - one orchestrator polls a bot (`poller.ts`).
 *
 * The fixed sentences are in the question's language (D224); the answer is in
 * it too, written by the model (D220).
 */

import { writtenLanguage } from '@traders/shared';
import { AiServiceError, type AiClient, type AssistantReply } from '@traders/shared/ai';

import { findTelegramConversation, setTelegramConversation } from '../db/queries.js';
import { userKey, type RateLimits } from '../http/rateLimits.js';
import { logger } from '../logger.js';
import { messagesFor, type Messages } from '../notify/messages.js';
import type { TelegramNotifier } from './client.js';
import { plainAnswer } from './plainAnswer.js';

/** The AI service's own bound on a question (`AssistantMessageRequest.message`). */
export const MAX_QUESTION_CHARS = 2000;

/** A chat quiet this long starts a new conversation with its next question (D222). */
export const QUIET_HOURS = 12;

/** Telegram shows "typing…" for about five seconds; renewed a little sooner. */
export const TYPING_RENEW_MS = 4_500;

/** Chats with a question being answered right now. */
const answering = new Set<string>();

export interface Question {
  telegram: TelegramNotifier | null;
  ai: AiClient;
  userId: string;
  chatId: string;
  question: string;
  /** The Ask page's limit, counted with it (D257). */
  rateLimits: RateLimits;
}

/**
 * Refuse the question or start answering it. `done` settles once the answer
 * (or what stands in for it) is sent; the caller does not wait for it.
 */
export async function startQuestion(input: Question): Promise<{ done: Promise<void> }> {
  const { telegram, chatId, question } = input;
  const messages = messagesFor(writtenLanguage(question));
  if (question.length > MAX_QUESTION_CHARS) {
    await telegram?.sendText(chatId, messages.ask.tooLong(MAX_QUESTION_CHARS));
    return { done: Promise.resolve() };
  }
  if (answering.has(chatId)) {
    await telegram?.sendText(chatId, messages.ask.stillAnswering);
    return { done: Promise.resolve() };
  }
  const refusal = await input.rateLimits.take('assistantQuestion', userKey(input.userId));
  if (refusal !== null) {
    await telegram?.sendText(chatId, messages.rateLimited(minutesOf(refusal.retryAfterSeconds)));
    return { done: Promise.resolve() };
  }
  answering.add(chatId);
  const done = answer(input, messages)
    .catch((error: unknown) => {
      logger().error({ err: error, chatId }, 'telegram.question_failed');
    })
    .finally(() => answering.delete(chatId));
  return { done };
}

/** Whole minutes to wait, at least one: what a chat message can say. */
export function minutesOf(seconds: number): number {
  return Math.max(1, Math.ceil(seconds / 60));
}

async function answer(input: Question, messages: Messages): Promise<void> {
  const { telegram, chatId, userId } = input;
  await telegram?.sendTyping(chatId);
  const typing = setInterval(() => void telegram?.sendTyping(chatId), TYPING_RENEW_MS);
  // Never the reason the process stays up.
  typing.unref();
  try {
    const reply = await ask(input);
    if (reply === null) {
      await telegram?.sendText(chatId, messages.ask.unavailable);
      return;
    }
    if (reply.conversation_id !== null) await setTelegramConversation(userId, reply.conversation_id);
    await telegram?.sendAnswer(chatId, plainAnswer(reply, messages, telegram.linkBase), reply.suggestions);
  } finally {
    clearInterval(typing);
  }
}

/** The assistant's reply, or null when the AI service could not give one. */
async function ask(input: Question): Promise<AssistantReply | null> {
  const { ai, userId, question } = input;
  const conversationId = await findTelegramConversation(userId, QUIET_HOURS);
  const send = (conversation: string | null) =>
    ai.assistantMessage({ user_id: userId, conversation_id: conversation, message: question });
  try {
    return await send(conversationId);
  } catch (error) {
    // Deleted on the Ask page between the read and the question: start afresh.
    if (error instanceof AiServiceError && error.status === 404 && conversationId !== null) {
      try {
        return await send(null);
      } catch (retry) {
        logger().warn({ err: retry, userId }, 'telegram.question_unanswered');
        return null;
      }
    }
    logger().warn({ err: error, userId }, 'telegram.question_unanswered');
    return null;
  }
}
