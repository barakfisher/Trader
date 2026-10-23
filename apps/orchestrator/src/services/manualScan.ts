/**
 * *Run a scan now* (D15, D50, D65): one scan of a simulated agent, asked for by
 * its owner on the agent page or from Telegram (M11 A2). Both come through
 * here, so a tap and a click meet the same refusals with the same codes (D276).
 *
 * The refusals before any money is spent on a model: the real portfolio never
 * scans (D1), a paused or archived agent does not (D18), and an agent with
 * nothing to decide by does not (D174). The AI service checks the same things
 * itself, so a scan cannot start by another path; its refusals are passed on
 * with their codes. A `trade` scan becomes proposals here, announced to the
 * user (`tradeProposals.ts`).
 */

import type { AgentScanResponse } from '@traders/shared/ai';
import { AiServiceError } from '@traders/shared/ai';

import type { AgentRow } from '../db/queries.js';
import { ApiProblem, aiRefusal, conflict, notFound, upstreamFailure } from '../http/errors.js';
import { readyToScan } from './agentReadiness.js';
import { proposeFromScan, type TradeProposalContext } from './tradeProposals.js';

/** Why a scan cannot start, before the AI service is asked; null when it can. */
export function scanBlocked(agent: AgentRow): ApiProblem | null {
  if (agent.is_primary) return conflict('primary_agent_is_passive', 'the real portfolio never scans or trades');
  if (agent.state !== 'active') return conflict('agent_not_active', `the agent is ${agent.state}; resume it to scan`);
  if (!readyToScan(agent)) {
    return conflict('no_persona', 'give the agent instructions or settings first: it decides by them');
  }
  return null;
}

/** Run the scan and propose what it decided. Throws `ApiProblem` for every refusal. */
export async function runManualScan(
  userId: string,
  agent: AgentRow,
  context: TradeProposalContext,
): Promise<{ scan: AgentScanResponse; proposalIds: string[] }> {
  const blocked = scanBlocked(agent);
  if (blocked !== null) throw blocked;

  let scan: AgentScanResponse;
  try {
    scan = await context.ai.scanAgent(agent.id, { user_id: userId, trigger: 'manual' }, context.requestId);
  } catch (error) {
    if (error instanceof AiServiceError) {
      const reason = aiRefusal(error.body);
      if (error.status === 404) throw notFound('agent not found');
      if (error.status === 409 && reason) throw conflict(reason.code, reason.message);
      if (error.status === 503 && reason?.code === 'no_model') {
        // Its own code, which the agent page translates (`AgentScans.tsx` RUN_REFUSALS).
        throw new ApiProblem(503, 'no_model', 'No model is configured for scans. Choose one on the Admin page.');
      }
      throw upstreamFailure(error.status, 'The scan could not run.');
    }
    throw error;
  }
  const proposalIds = await proposeFromScan(userId, agent, scan, context);
  return { scan, proposalIds };
}
