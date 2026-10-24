/**
 * Research on the main portfolio (D254, D289-D293): what the research page and
 * the Dashboard's *Sentiment* column read, and starting a run.
 *
 * The AI service runs the research and stores each rating; this module turns
 * the rows into the wire's shape - the stale mark included (D293) - and passes
 * the AI service's refusals on with their codes, so the page can say each one
 * in the user's language.
 */

import {
  RESEARCH_STALE_DAYS,
  type ResearchHolding,
  type ResearchResponse,
  type ResearchRunSummary,
} from '@traders/shared';
import type { AiClient, ResearchRunStarted } from '@traders/shared/ai';
import { AiServiceError } from '@traders/shared/ai';

import {
  getLatestResearchRun,
  getResearchAgent,
  listResearchHoldings,
  type ResearchHoldingRow,
  type ResearchRunRow,
} from '../db/queries.js';
import { ApiProblem, aiRefusal, conflict, upstreamFailure } from '../http/errors.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether a rating made at `ratedAt` is older than the stale mark's age (D293). */
export function isStale(ratedAt: Date, now: Date): boolean {
  return now.getTime() - ratedAt.getTime() > RESEARCH_STALE_DAYS * DAY_MS;
}

function findingsOf(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : [];
}

export function toResearchHolding(row: ResearchHoldingRow, now: Date): ResearchHolding {
  const rated = row.rating !== null && row.rationale !== null && row.rated_at !== null;
  const unrated =
    row.last_status !== null && row.last_status !== 'rated' && row.last_at !== null
      ? { status: row.last_status, at: row.last_at.toISOString() }
      : null;
  return {
    instrumentId: row.instrument_id,
    symbol: row.symbol,
    name: row.name,
    latest: rated
      ? {
          rating: row.rating!,
          rationale: row.rationale!,
          findings: findingsOf(row.findings),
          agentName: row.agent_name ?? '',
          ratedAt: row.rated_at!.toISOString(),
          stale: isStale(row.rated_at!, now),
        }
      : null,
    lastAttempt: unrated,
  };
}

export function toRunSummary(row: ResearchRunRow): ResearchRunSummary {
  return {
    id: row.id,
    trigger: row.trigger,
    status: row.status,
    holdings: row.holdings,
    rated: row.rated,
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
    error: row.error,
  };
}

/** `GET /api/research`: the assigned agent, its latest run, and every holding's latest rating. */
export async function readResearch(userId: string, now = new Date()): Promise<ResearchResponse> {
  const [agent, run] = await Promise.all([getResearchAgent(userId), getLatestResearchRun(userId)]);
  const rows = await listResearchHoldings(userId, agent?.id ?? null);
  return {
    agent,
    run: run === null ? null : toRunSummary(run),
    holdings: rows.map((row) => toResearchHolding(row, now)),
  };
}

/**
 * Start the assigned agent's research now. Throws `ApiProblem` for every
 * refusal: the AI service's 409s keep their codes, a missing model is 503.
 */
export async function startResearch(
  userId: string,
  ai: AiClient,
  trigger: 'manual' | 'schedule',
  requestId?: string,
): Promise<ResearchRunStarted> {
  try {
    return await ai.startResearch({ user_id: userId, trigger }, requestId);
  } catch (error) {
    if (error instanceof AiServiceError) {
      const reason = aiRefusal(error.body);
      if (error.status === 409 && reason) throw conflict(reason.code, reason.message);
      if (error.status === 503 && reason?.code === 'no_model') {
        throw new ApiProblem(503, 'no_model', 'No model is configured. Choose one on the Admin page.');
      }
      throw upstreamFailure(error.status, 'The research could not start.');
    }
    throw error;
  }
}
