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
import { notFound, upstreamFailure } from '../errors.js';

export function registerConceptsRoutes(app: Hono<AppEnv>): void {
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
