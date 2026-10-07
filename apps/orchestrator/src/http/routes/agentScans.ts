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
import { z } from 'zod';

import type {
  AgentScanDetail,
  AgentScanOutcome,
  AgentScanStep,
  AgentScanSummary,
  AgentScansResponse,
} from '@traders/shared';
import { AiServiceError } from '@traders/shared/ai';

import { getAgent, getAgentScan, listAgentScans, type AgentScanRow } from '../../db/queries.js';
import { effectiveState } from '../../services/proposalState.js';
import { currentUserId, type AppEnv } from '../app.js';
import { badRequest, conflict, notFound, upstreamFailure } from '../errors.js';
import { proposeFromScan } from '../../services/tradeProposals.js';
import { agentIdFrom } from './agents.js';

/** A page of the *Decisions* tab. */
export const SCANS_PAGE_SIZE = 20;

const listQuery = z.object({ before: z.string().datetime({ offset: true }).optional() });

const decisionOf = (value: unknown): AgentScanSummary['decision'] =>
  value === 'buy' || value === 'sell' || value === 'none' ? value : null;

const textOf = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export function toScanSummary(row: AgentScanRow, now: Date): AgentScanSummary {
  const answer = row.answer ?? {};
  return {
    id: row.id,
    trigger: row.trigger === 'schedule' ? 'schedule' : 'manual',
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
    outcome: row.outcome as AgentScanOutcome | null,
    steps: row.steps,
    costMicroUsd: Number(row.cost_micro_usd),
    model: row.model,
    decision: decisionOf(answer.decision),
    symbol: textOf(answer.symbol),
    quantity: textOf(answer.quantity),
    problems: Array.isArray(answer.problems) ? answer.problems.filter((p): p is string => typeof p === 'string') : [],
    error: row.error,
    // The state now, not as stored: a proposal past its deadline reads expired
    // before the sweep catches up, as everywhere else.
    proposal:
      row.proposal_id === null
        ? null
        : {
            id: row.proposal_id,
            state: effectiveState(
              {
                state: row.proposal_state as never,
                expiresAt: row.proposal_expires_at!,
                snoozedUntil: row.proposal_snoozed_until,
                decidedAt: row.proposal_decided_at,
              },
              now,
            ),
          },
    fillId: row.fill_id,
  };
}

/**
 * A stored transcript step in the wire's shape. The AI service writes
 * `tool_calls` and `call_id` (scan.py); anything it does not recognise is left
 * out rather than shown half-read.
 */
export function toScanStep(raw: unknown): AgentScanStep | null {
  const step = raw as Record<string, unknown> | null;
  if (step?.role === 'assistant') {
    const calls = Array.isArray(step.tool_calls) ? (step.tool_calls as Record<string, unknown>[]) : [];
    return {
      role: 'assistant',
      text: textOf(step.text),
      toolCalls: calls.map((call) => ({ id: String(call.id), name: String(call.name), arguments: call.arguments })),
    };
  }
  if (step?.role === 'tool') {
    return { role: 'tool', callId: String(step.call_id), name: String(step.name), result: step.result };
  }
  return null;
}

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

  /** The *Decisions* tab (D50): every scan, newest first, a page at a time. */
  app.get('/agents/:id/scans', async (context) => {
    const userId = currentUserId(context);
    const agentId = agentIdFrom(context.req.param('id'));
    const parsed = listQuery.safeParse(context.req.query());
    if (!parsed.success) throw badRequest('invalid_query', 'before must be an ISO 8601 time', parsed.error.issues);
    if (!(await getAgent(userId, agentId))) throw notFound('agent not found');
    const before = parsed.data.before === undefined ? undefined : new Date(parsed.data.before);
    // One more than a page, to know whether an older one exists.
    const rows = await listAgentScans(userId, agentId, { limit: SCANS_PAGE_SIZE + 1, before });
    const now = new Date();
    const page = rows.slice(0, SCANS_PAGE_SIZE);
    const body: AgentScansResponse = {
      scans: page.map((row) => toScanSummary(row, now)),
      nextBefore: rows.length > SCANS_PAGE_SIZE ? page.at(-1)!.started_at.toISOString() : null,
    };
    return context.json(body);
  });

  /** One scan with its briefing and every step, when its row is expanded. */
  app.get('/agents/:id/scans/:scanId', async (context) => {
    const userId = currentUserId(context);
    const agentId = agentIdFrom(context.req.param('id'));
    const scanId = context.req.param('scanId');
    if (!z.string().uuid().safeParse(scanId).success) throw notFound('scan not found');
    const row = await getAgentScan(userId, agentId, scanId);
    if (!row) throw notFound('scan not found');
    const body: AgentScanDetail = {
      ...toScanSummary(row, new Date()),
      briefing: row.briefing,
      transcript: (Array.isArray(row.transcript) ? row.transcript : [])
        .map(toScanStep)
        .filter((step): step is AgentScanStep => step !== null),
      thesis: textOf(row.answer?.thesis),
    };
    return context.json(body);
  });
}
