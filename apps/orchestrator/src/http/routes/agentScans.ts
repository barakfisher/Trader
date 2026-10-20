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
  AgentScanTrade,
} from '@traders/shared';
import { AiServiceError } from '@traders/shared/ai';

import { getAgent, getAgentScan, listAgentScans, type AgentScanRow } from '../../db/queries.js';
import { effectiveState } from '../../services/proposalState.js';
import { currentUserId, type AppEnv } from '../app.js';
import { badRequest, conflict, notFound, upstreamFailure } from '../errors.js';
import { proposeFromScan } from '../../services/tradeProposals.js';
import { readyToScan } from '../../services/agentReadiness.js';
import { agentIdFrom } from './agents.js';

/** A page of the *Decisions* tab. */
export const SCANS_PAGE_SIZE = 20;

const listQuery = z.object({ before: z.string().datetime({ offset: true }).optional() });

const sideOf = (value: unknown): AgentScanTrade['decision'] => (value === 'buy' || value === 'sell' ? value : null);

const textOf = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const textsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/**
 * The trades an answer wrote, as stored: the list since D197, or the one trade
 * every answer was before it (`{decision, symbol, quantity}`; `none` is no trade).
 */
function writtenTrades(answer: Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray(answer.trades)) {
    return answer.trades.filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null);
  }
  return answer.decision === 'buy' || answer.decision === 'sell' ? [answer] : [];
}

/**
 * The answer's own reason: a pass's why, or an overview beside its trades. In a
 * one-trade answer from before D197 the thesis is that trade's, already shown
 * under it (`writtenTrades`), so it is not the answer's too.
 */
function answerThesis(answer: Record<string, unknown>): string | null {
  return writtenTrades(answer).includes(answer) ? null : textOf(answer.thesis);
}

export function toScanSummary(row: AgentScanRow, now: Date): AgentScanSummary {
  const answer = row.answer ?? {};
  // Each trade's proposal is the scan's proposal for its symbol (one per symbol, 0061).
  const bySymbol = new Map(row.proposals.map((proposal) => [proposal.symbol, proposal]));
  const trades = writtenTrades(answer).map((written): AgentScanTrade => {
    const symbol = textOf(written.symbol);
    const current = Array.isArray(answer.trades);
    // Before D197 an answer's one trade was proposed exactly when the scan was a `trade`.
    const refused = current ? written.refused === true : row.outcome !== 'trade';
    const proposal = refused || symbol === null ? undefined : bySymbol.get(symbol.toUpperCase());
    return {
      decision: sideOf(written.decision),
      symbol,
      quantity: textOf(written.quantity),
      thesis: textOf(written.thesis),
      fundedBy: textsOf(written.funded_by),
      refused,
      // Before D197 a refused answer's reasons were the answer's own, and so its one trade's.
      problems: textsOf(written.problems),
      // The state now, not as stored: a proposal past its deadline reads expired
      // before the sweep catches up, as everywhere else.
      proposal: proposal
        ? {
            id: proposal.id,
            state: effectiveState(
              {
                state: proposal.state as never,
                expiresAt: new Date(proposal.expires_at),
                snoozedUntil: proposal.snoozed_until === null ? null : new Date(proposal.snoozed_until),
                decidedAt: proposal.decided_at === null ? null : new Date(proposal.decided_at),
              },
              now,
            ),
          }
        : null,
      fillId: proposal?.fill_id ?? null,
    };
  });
  return {
    id: row.id,
    trigger: row.trigger === 'schedule' ? 'schedule' : 'manual',
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
    outcome: row.outcome as AgentScanOutcome | null,
    steps: row.steps,
    costMicroUsd: Number(row.cost_micro_usd),
    model: row.model,
    trades,
    problems: textsOf(answer.problems),
    error: row.error,
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
  if (step?.role === 'returned' && Array.isArray(step.problems)) {
    return { role: 'returned', problems: step.problems.map(String) };
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
    if (!readyToScan(agent)) {
      throw conflict('no_persona', 'give the agent instructions or settings first: it decides by them');
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
    const proposalIds = await proposeFromScan(userId, agent, scan, {
      ai: context.get('ai'),
      notifier: context.get('notifier'),
      requestId: context.get('requestId'),
    });
    return context.json({ ...scan, proposal_ids: proposalIds });
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
      thesis: answerThesis(row.answer ?? {}),
    };
    return context.json(body);
  });
}
