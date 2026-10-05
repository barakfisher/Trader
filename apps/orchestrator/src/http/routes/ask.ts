/**
 * `POST /ask` (FR-17, M3 slice 3): the browser's one question-shaped entry point.
 *
 * Thinner than it looks, but not a pure proxy like `/concepts/:slug`. The AI
 * service owns the corpus, the retrieval and the relevance floor; it does *not*
 * own the user's holdings, and cannot. So this route does the one thing the
 * orchestrator is for: it values the portfolio and sends it along, using exactly
 * the same shape `portfolioScan` already builds.
 *
 * **The portfolio always travels, whatever the question looks like.** Routing
 * happens in the AI service, where the concept corpus is, so deciding here
 * whether a question needs holdings would mean a second classifier that has to
 * agree with the first - and the failure when they disagree is silent: a
 * portfolio question refused for missing data the caller did have. Valuing costs
 * one cached read, and the alternative costs correctness.
 *
 * **A refusal is a 200 and is passed straight through.** `answered: false` with
 * a `refused_reason` is an outcome, not a fault. Rewriting it to a 4xx here
 * would make "the corpus does not cover that" indistinguishable from "the corpus
 * failed to load" to the browser, which is the distinction the whole floor
 * exists to draw.
 */

import type { Hono } from 'hono';

import { AiServiceError } from '@traders/shared/ai';

import { getUser, listHoldings, listTargetWeights, primaryAgentId } from '../../db/queries.js';
import { valuePortfolio } from '../../services/valuation.js';
import { currentUserId, type AppEnv } from '../app.js';
import { badRequest, notFound, upstreamFailure } from '../errors.js';

/** Longest question accepted, mirroring the AI service's own bound. */
const MAX_QUESTION_LENGTH = 1000;

export function registerAskRoutes(app: Hono<AppEnv>): void {
  app.post('/ask', async (context) => {
    const userId = currentUserId(context);
    const ai = context.get('ai');
    const requestId = context.get('requestId');

    const body = (await context.req.json().catch(() => null)) as { question?: unknown } | null;
    const question = typeof body?.question === 'string' ? body.question.trim() : '';

    if (!question) {
      throw badRequest('missing_question', 'a question is required: send { question: string }');
    }
    if (question.length > MAX_QUESTION_LENGTH) {
      throw badRequest(
        'question_too_long',
        `a question may be at most ${MAX_QUESTION_LENGTH} characters`,
      );
    }

    const user = await getUser(userId);
    if (!user) throw notFound('user not found');

    // `/ask` answers about the real portfolio.
    const agentId = await primaryAgentId(userId);
    const rows = await listHoldings(userId, agentId);
    const targets = await listTargetWeights(userId, agentId);

    // An empty portfolio is a legitimate state, not an error: a new account can
    // still ask what a drawdown is. It sends no holdings, and a portfolio
    // question then comes back refused with `no_holdings`, which is the honest
    // answer rather than a 400 about a question that was perfectly well formed.
    const holdings =
      rows.length === 0
        ? []
        : (
            await valuePortfolio(rows, {
              baseCurrency: user.base_currency,
              ai,
              requestId,
            })
          ).holdings.map((holding) => ({
            instrument_id: holding.instrument.id,
            symbol: holding.instrument.symbol,
            // Null rather than zero, exactly as the scan sends it: an unpriced
            // holding is a known unknown, and `/ask` reports how many it could
            // not see rather than quietly totalling the rest.
            value_minor: holding.valueMinor,
            currency: user.base_currency,
            as_of: holding.quote?.asOf ?? null,
          }));

    try {
      return context.json(
        await ai.ask(
          {
            question,
            user_id: userId,
            base_currency: user.base_currency,
            holdings,
            // Symbol -> decimal string, exactly as stored. A weight never
            // becomes a number on this side of the wire (guideline 4).
            target_weights: Object.fromEntries(targets.map((t) => [t.symbol, t.weight])),
          },
          requestId,
        ),
      );
    } catch (error) {
      if (error instanceof AiServiceError) {
        throw upstreamFailure(error.status, 'The question could not be answered.');
      }
      throw error;
    }
  });
}
