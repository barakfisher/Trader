/**
 * `POST /topics/resolve` (FR-10, M5): a theme in the user's words, candidate
 * instruments out.
 *
 * A proxy, like `/concepts/:slug`. The universe, the embeddings and the resolver
 * all live in the AI service, which owns the schema they are stored in; a second
 * reader of `instrument_profiles` here would be a second place that has to agree
 * about which model's vectors count.
 *
 * **`verdict: 'unavailable'` is passed through as a 200.** It means this
 * installation has no searchable universe - the descriptions are not committed,
 * so a fresh clone has none - and `universe.state` names the missing step. That
 * is a state of the deployment rather than a fault, and it is not the same
 * statement as `verdict: 'none'` (the universe was searched and nothing in it is
 * about the topic). Rewriting either into an error status would erase exactly
 * the distinction the AI service went out of its way to draw.
 *
 * Nothing is stored. Resolution proposes; keeping a topic and confirming its
 * instruments are separate, user-owned writes.
 */

import type { Hono } from 'hono';

import { AiServiceError } from '@traders/shared/ai';

import { currentUserId, type AppEnv } from '../app.js';
import { badRequest, upstreamFailure } from '../errors.js';

/** Longest topic accepted, mirroring the AI service's own bound. */
export const MAX_TOPIC_LENGTH = 200;

export function registerTopicsRoutes(app: Hono<AppEnv>): void {
  app.post('/topics/resolve', async (context) => {
    // The universe is shared reference data with no `user_id` (migration 0015),
    // but resolving against it is part of the product and sits behind the gate.
    currentUserId(context);

    const body = (await context.req.json().catch(() => null)) as { topic?: unknown } | null;
    const topic = typeof body?.topic === 'string' ? body.topic.trim() : '';

    if (!topic) {
      throw badRequest('missing_topic', 'a topic is required: send { topic: string }');
    }
    if (topic.length > MAX_TOPIC_LENGTH) {
      throw badRequest('topic_too_long', `a topic may be at most ${MAX_TOPIC_LENGTH} characters`);
    }

    try {
      return context.json(await context.get('ai').resolveTopic(topic, context.get('requestId')));
    } catch (error) {
      if (error instanceof AiServiceError) {
        throw upstreamFailure(error.status, 'The topic could not be resolved.');
      }
      throw error;
    }
  });
}
