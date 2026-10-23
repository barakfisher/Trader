/**
 * `POST /agents/:id/scans`: run one scan of a simulated agent now (Stage 4, PR 4;
 * D15 and D50 in `docs/PROPOSAL-MULTI-AGENT.md`).
 *
 * The AI service runs the scan and stores it; this route owns the session and
 * the rate limit. The checks before any money is spent, the call, and turning a
 * `trade` scan into proposals are `services/manualScan.ts`, shared with the
 * Telegram agent controls (M11 A2) so the two meet the same refusals. The
 * proposals' ids are returned beside the scan: the AI service owns the scan,
 * the orchestrator owns what the user is asked.
 */

import type { Hono } from 'hono';
import { z } from 'zod';

import type {
  AgentScanDetail,
  AgentScanStep,
  AgentScansResponse,
} from '@traders/shared';

import { getAgent, getAgentScan, listAgentScans } from '../../db/queries.js';
import { answerThesis, textOf, toScanSummary } from '../../services/scanSummary.js';
import { currentUserId, type AppEnv } from '../app.js';
import { badRequest, notFound } from '../errors.js';
import { runManualScan } from '../../services/manualScan.js';
import { agentIdFrom } from './agents.js';
import { limitPerUser } from '../rateLimits.js';

/** A page of the *Decisions* tab. */
export const SCANS_PAGE_SIZE = 20;

const listQuery = z.object({ before: z.string().datetime({ offset: true }).optional() });


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

export function registerAgentScanRoutes(app: Hono<AppEnv>): void {
  app.post('/agents/:id/scans', limitPerUser('agentScan'), async (context) => {
    const userId = currentUserId(context);
    const agent = await getAgent(userId, agentIdFrom(context.req.param('id')));
    if (!agent) throw notFound('agent not found');
    const { scan, proposalIds } = await runManualScan(userId, agent, {
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
