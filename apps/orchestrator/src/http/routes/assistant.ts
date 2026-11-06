/**
 * The assistant (`/ask` with tools, migration 0052): one question at a time, and
 * the conversations the screen lists, reads back and deletes.
 *
 * `POST /assistant/messages` passes the question to the AI service with the
 * signed-in user. Nothing is valued or assembled here, unlike `/ask`: the
 * assistant looks the account up itself, with its tools, scoped to that user.
 *
 * **Every reply is a 200, and is passed straight through** - a decline, a
 * failure, a spent budget, no model. Each is an outcome the screen shows as
 * itself; a 4xx would make a correct decline look like a broken service. The
 * one 404 is a conversation that is not this user's, the same answer as one
 * that does not exist.
 *
 * Listing, reading and deleting are this side's own SQL (`queries/assistant.ts`),
 * as for every table the screens read. A reply's tool transcript is not sent to
 * the browser: it is the review record, and the screen shows sources.
 *
 * **A drafted proposal (D393)** comes with its reply and is written only by
 * `POST /assistant/messages/:id/proposal-draft/add`, the user's tap. A user who
 * may not receive advice (`isAdvisory`, D388) is shown no draft at all.
 */

import type { Hono } from 'hono';
import { z } from 'zod';

import type {
  AssistantConversationResponse,
  AssistantConversationsResponse,
  AssistantConversationSummary,
  AssistantProposalDraftView,
  AssistantReplyView,
  AssistantSourceView,
} from '@traders/shared';
import { AiServiceError, type AssistantReply } from '@traders/shared/ai';

import {
  deleteAssistantConversation,
  findAssistantDraft,
  getAssistantConversation,
  listAssistantConversations,
  listAssistantMessages,
  type AssistantConversationRow,
  type AssistantMessageRow,
} from '../../db/queries.js';
import { currentUserId, type AppEnv } from '../app.js';
import { badRequest, notFound, upstreamFailure } from '../errors.js';
import { limitPerUser } from '../rateLimits.js';
import { isAdvisory } from '../../services/advisoryMode.js';
import { addDraftToProposals, closeDraft, draftView } from '../../services/assistantProposals.js';
import { announceModelFallbacks } from '../../services/modelFallbacks.js';

/** The AI service's own bound (`AssistantMessageRequest.message`). */
const MAX_MESSAGE_LENGTH = 2000;
/** Conversations listed: the screen's history, newest first. */
const CONVERSATIONS_LIMIT = 50;

const messageSchema = z
  .object({
    message: z.string().max(MAX_MESSAGE_LENGTH),
    conversationId: z.string().uuid().optional(),
  })
  .strict();
const conversationId = z.string().uuid();

export function registerAssistantRoutes(app: Hono<AppEnv>): void {
  app.post('/assistant/messages', limitPerUser('assistantQuestion'), async (context) => {
    const parsed = messageSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      throw badRequest(
        'invalid_body',
        `expected { message: string (at most ${MAX_MESSAGE_LENGTH} characters), conversationId?: uuid }`,
        parsed.error.issues,
      );
    }
    let reply: AssistantReply;
    try {
      reply = await context.get('ai').assistantMessage(
        {
          user_id: currentUserId(context),
          conversation_id: parsed.data.conversationId ?? null,
          message: parsed.data.message,
        },
        context.get('requestId'),
      );
    } catch (error) {
      if (error instanceof AiServiceError && error.status === 404) throw notFound('conversation not found');
      if (error instanceof AiServiceError) throw upstreamFailure(error.status, 'The assistant could not answer.');
      throw error;
    }
    const body: AssistantReplyView = {
      conversationId: reply.conversation_id,
      messageId: reply.message_id,
      outcome: reply.outcome,
      reason: reply.reason,
      text: reply.text,
      sources: reply.sources.map(toSource),
      suggestions: reply.suggestions,
      fallbackFrom: reply.fallback_from ?? null,
      proposalDraft: await draftOfReply(currentUserId(context), reply),
    };
    await announceModelFallbacks(currentUserId(context), context.get('notifier'));
    return context.json(body);
  });

  app.get('/assistant/conversations', async (context) => {
    const rows = await listAssistantConversations(currentUserId(context), CONVERSATIONS_LIMIT);
    const body: AssistantConversationsResponse = { conversations: rows.map(toSummary) };
    return context.json(body);
  });

  app.get('/assistant/conversations/:id', async (context) => {
    const id = context.req.param('id');
    if (!conversationId.safeParse(id).success) throw notFound('conversation not found');
    const userId = currentUserId(context);
    const conversation = await getAssistantConversation(userId, id);
    if (conversation === null) throw notFound('conversation not found');
    const messages = await listAssistantMessages(userId, id);
    const advisory = await isAdvisory(userId);
    const now = new Date();
    const body: AssistantConversationResponse = {
      conversation: toSummary(conversation),
      messages: messages.map((message) => ({
        id: message.id,
        role: message.role,
        text: message.content,
        outcome: message.outcome,
        reason: message.reason,
        sources: (Array.isArray(message.sources) ? message.sources : []).map(toSource),
        suggestions: Array.isArray(message.suggestions)
          ? message.suggestions.filter((s): s is string => typeof s === 'string')
          : [],
        createdAt: message.created_at.toISOString(),
        proposalDraft: advisory ? storedDraft(message, now) : null,
      })),
    };
    return context.json(body);
  });

  /** The user's tap: the one write behind a drafted proposal, and the only way it happens. */
  app.post('/assistant/messages/:id/proposal-draft/add', async (context) => {
    const id = context.req.param('id');
    if (!conversationId.safeParse(id).success) throw notFound('draft not found');
    const draft = await addDraftToProposals(currentUserId(context), id);
    if (draft === null) throw notFound('draft not found');
    return context.json(draft);
  });

  /** Close: marks the draft, and writes no proposal. */
  app.post('/assistant/messages/:id/proposal-draft/close', async (context) => {
    const id = context.req.param('id');
    if (!conversationId.safeParse(id).success) throw notFound('draft not found');
    const draft = await closeDraft(currentUserId(context), id);
    if (draft === null) throw notFound('draft not found');
    return context.json(draft);
  });

  /** "Delete this conversation": the conversation and every message in it. */
  app.delete('/assistant/conversations/:id', async (context) => {
    const id = context.req.param('id');
    if (!conversationId.safeParse(id).success) throw notFound('conversation not found');
    if (!(await deleteAssistantConversation(currentUserId(context), id))) {
      throw notFound('conversation not found');
    }
    return context.body(null, 204);
  });
}

/** A fresh reply's draft, read back from its row: the row is what a tap will act on. */
async function draftOfReply(userId: string, reply: AssistantReply): Promise<AssistantProposalDraftView | null> {
  if (!reply.proposal_draft || reply.message_id === null || !(await isAdvisory(userId))) return null;
  const row = await findAssistantDraft(userId, reply.message_id);
  return row === null ? null : draftView(row, new Date());
}

function storedDraft(message: AssistantMessageRow, now: Date): AssistantProposalDraftView | null {
  if (message.proposal_draft === null || message.proposal_draft_state === null) return null;
  return draftView(
    {
      created_at: message.created_at,
      proposal_draft: message.proposal_draft,
      proposal_draft_state: message.proposal_draft_state,
      proposal_draft_proposal_id: message.proposal_draft_proposal_id,
    },
    now,
  );
}

function toSummary(row: AssistantConversationRow): AssistantConversationSummary {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toSource(source: unknown): AssistantSourceView {
  const value = (source ?? {}) as Record<string, unknown>;
  const text = (key: string) => (typeof value[key] === 'string' ? (value[key] as string) : null);
  const kind = text('kind');
  return {
    kind: kind === 'news' || kind === 'concept' || kind === 'page' ? kind : 'data',
    label: text('label') ?? '',
    url: text('url'),
    link: text('link'),
    published: text('published'),
  };
}
