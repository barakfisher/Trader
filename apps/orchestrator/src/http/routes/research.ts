/**
 * Research on the main portfolio (D254, D289-D293).
 *
 * - `GET /research`: the assigned agent, its latest run and each holding's
 *   latest rating - the research page and the Dashboard's *Sentiment* column.
 * - `PUT /research/agent`: assign one of the user's agents, or none.
 * - `POST /research/runs`: start a run now. It answers 202 as soon as the AI
 *   service has claimed the run; the page reads its progress from `GET`. Rate
 *   limited per user like every route that spends the model (D257).
 */

import type { Hono } from 'hono';
import { z } from 'zod';

import { setResearchAgent } from '../../db/queries.js';
import { readResearch, startResearch } from '../../services/research.js';
import { currentUserId, type AppEnv } from '../app.js';
import { badRequest, notFound } from '../errors.js';
import { limitPerUser } from '../rateLimits.js';

const agentBody = z.object({ agentId: z.string().uuid().nullable() }).strict();

export function registerResearchRoutes(app: Hono<AppEnv>): void {
  app.get('/research', async (context) => {
    return context.json(await readResearch(currentUserId(context)));
  });

  app.put('/research/agent', async (context) => {
    const userId = currentUserId(context);
    const parsed = agentBody.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      throw badRequest('invalid_body', 'agentId is an agent id, or null for none', parsed.error.issues);
    }
    if (!(await setResearchAgent(userId, parsed.data.agentId))) throw notFound('agent not found');
    return context.json(await readResearch(userId));
  });

  app.post('/research/runs', limitPerUser('researchRun'), async (context) => {
    const userId = currentUserId(context);
    const started = await startResearch(userId, context.get('ai'), 'manual', context.get('requestId'));
    return context.json(started, 202);
  });
}
