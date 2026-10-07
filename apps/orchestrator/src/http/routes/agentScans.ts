/**
 * `POST /agents/:id/scans`: run one scan of a simulated agent now (Stage 4, PR 4;
 * D15 and D50 in `docs/PROPOSAL-MULTI-AGENT.md`).
 *
 * The AI service runs the scan and stores it; this route owns the session and
 * says, before any money is spent on a model, why an agent cannot scan: the real
 * portfolio never does (D1), a paused or archived agent does not (D18), and an
 * agent with no persona has nothing to decide by. The AI service checks the same
 * things itself, so a scan cannot start by another path; its refusals are passed
 * on with their codes.
 *
 * A `trade` scan becomes a proposal here (PR 5a, `services/tradeProposals.ts`),
 * and its id is returned beside the scan: the AI service owns the scan, the
 * orchestrator owns what the user is asked.
 */

import type { Hono } from 'hono';

import { AiServiceError } from '@traders/shared/ai';

import { getAgent } from '../../db/queries.js';
import { currentUserId, type AppEnv } from '../app.js';
import { conflict, notFound, upstreamFailure } from '../errors.js';
import { proposeFromScan } from '../../services/tradeProposals.js';
import { agentIdFrom } from './agents.js';

/** The AI service's refusal body: FastAPI puts our `{ code, message }` under `detail`. */
function refusal(body: unknown): { code: string; message: string } | null {
  const detail = (body as { detail?: unknown } | undefined)?.detail as
    | { code?: unknown; message?: unknown }
    | undefined;
  return typeof detail?.code === 'string' && typeof detail.message === 'string'
    ? { code: detail.code, message: detail.message }
    : null;
}

export function registerAgentScanRoutes(app: Hono<AppEnv>): void {
  app.post('/agents/:id/scans', async (context) => {
    const userId = currentUserId(context);
    const agent = await getAgent(userId, agentIdFrom(context.req.param('id')));
    if (!agent) throw notFound('agent not found');
    if (agent.is_primary) {
      throw conflict('primary_agent_is_passive', 'the real portfolio never scans or trades');
    }
    if (agent.state !== 'active') {
      throw conflict('agent_not_active', `the agent is ${agent.state}; resume it to scan`);
    }
    if (!agent.persona?.trim()) {
      throw conflict('no_persona', 'give the agent a persona first: it decides by it');
    }

    let scan;
    try {
      scan = await context
        .get('ai')
        .scanAgent(agent.id, { user_id: userId, trigger: 'manual' }, context.get('requestId'));
    } catch (error) {
      if (error instanceof AiServiceError) {
        const reason = refusal(error.body);
        if (error.status === 404) throw notFound('agent not found');
        if (error.status === 409 && reason) throw conflict(reason.code, reason.message);
        if (error.status === 503 && reason?.code === 'no_model') {
          throw upstreamFailure(503, 'No model is configured for scans. Choose one on the Admin page.');
        }
        throw upstreamFailure(error.status, 'The scan could not run.');
      }
      throw error;
    }
    const proposalId = await proposeFromScan(userId, agent, scan, {
      ai: context.get('ai'),
      notifier: context.get('notifier'),
      requestId: context.get('requestId'),
    });
    return context.json({ ...scan, proposal_id: proposalId });
  });
}
