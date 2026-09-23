/**
 * Concept explainers: the other end of an observation's concept chips (FR-16).
 *
 * A thin proxy to the AI service, which owns the corpus, the ingester and - when
 * `/ask` lands - the retrieval that reads the same tables. This route exists
 * because the browser only ever talks to the orchestrator, not because there is
 * any decision to make here.
 *
 * The one judgement it does make is how a missing concept reads. The AI service
 * answers 404 for a slug the corpus does not hold, and that is not a fault: an
 * environment that has not ingested the corpus is a real state, and so is a rule
 * that names a concept nobody has written up yet. It is passed through as a 404
 * whose message says the corpus may not be loaded, so the UI can say "no
 * explanation available" instead of showing an error.
 *
 * Every other AI-service failure is reported as an upstream fault with its own
 * gateway status. A corpus lookup that times out is not the same as a concept
 * that does not exist, and collapsing the two would make a broken deployment
 * look like a gap in the documentation.
 */

import type { Hono } from 'hono';

import { AiServiceError } from '@traders/shared/ai';

import { currentUserId, type AppEnv } from '../app.js';
import { badRequest, notFound, upstreamFailure } from '../errors.js';

/**
 * Widest result set one request may ask for. Mirrors the AI service's own
 * bound rather than trusting it: this is the browser-facing edge, and a limit
 * enforced only upstream is a limit that disappears the moment anything else
 * calls that service.
 */
const MAX_SEARCH_LIMIT = 20;

export function registerConceptsRoutes(app: Hono<AppEnv>): void {
  /**
   * Hybrid retrieval over the corpus.
   *
   * Registered before `/concepts/:slug`, and that ordering is load-bearing in
   * exactly the way it is in the AI service's own router: Hono matches in
   * registration order, so the parameterised route declared first would swallow
   * this as a request for a concept called "search" - answering 404 about a slug
   * nobody asked for, which reads as an un-ingested corpus rather than as a
   * shadowed route.
   */
  app.get('/concepts/search', async (context) => {
    currentUserId(context);

    const query = context.req.query('q')?.trim() ?? '';
    if (!query) {
      throw badRequest('missing_query', 'a search needs a query: pass ?q=');
    }

    const rawLimit = context.req.query('limit');
    const limit = rawLimit === undefined ? undefined : Number(rawLimit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT)) {
      throw badRequest(
        'invalid_limit',
        `limit must be a whole number between 1 and ${MAX_SEARCH_LIMIT}`,
      );
    }

    const ai = context.get('ai');
    try {
      return context.json(await ai.searchConcepts(query, limit, context.get('requestId')));
    } catch (error) {
      if (error instanceof AiServiceError) {
        throw upstreamFailure(error.status, 'The corpus could not be searched.');
      }
      throw error;
    }
  });

  app.get('/concepts/:slug', async (context) => {
    // Not used for filtering - the corpus is shared reference material with no
    // `user_id` (see migration 0012) - but the route is behind the session gate
    // and this is what asserts it, rather than trusting the prefix list alone.
    currentUserId(context);

    const slug = context.req.param('slug');
    const ai = context.get('ai');

    try {
      return context.json(await ai.concept(slug, context.get('requestId')));
    } catch (error) {
      if (error instanceof AiServiceError) {
        if (error.status === 404) {
          throw notFound(
            `no explanation is available for "${slug}". The concept corpus may not have been ingested.`,
          );
        }
        throw upstreamFailure(error.status, 'The explanation could not be loaded.');
      }
      throw error;
    }
  });
}
