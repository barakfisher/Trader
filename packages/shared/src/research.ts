/**
 * Research on the main portfolio as the browser sees it (D254, D289-D293): the
 * agent assigned to it, its latest run, and each holding's latest rating.
 *
 * A rating is about the stock's outlook, never the user's position; the
 * research page carries the disclaimer, and the Dashboard's *Sentiment* column
 * always shows the word beside its colour (D254's guardrails 4 and 5).
 */

/** `0070_holding_research.RATINGS`; the AI service's `rating.RATINGS` says the same. */
export const SENTIMENT_RATINGS = ['bullish', 'bearish', 'neutral'] as const;
export type SentimentRating = (typeof SENTIMENT_RATINGS)[number];

/** D293: a rating older than this many days is marked stale, beside its date. */
export const RESEARCH_STALE_DAYS = 7;

/**
 * A run still `running` after this long was cut short by a restart, and is read
 * as failed; the AI service's `store.ABANDONED_AFTER` closes it out the same way.
 */
export const RESEARCH_ABANDONED_AFTER_MINUTES = 20;

/** Why a research run could not start: a 409's `code` (the payer refusals besides). */
export const RESEARCH_REFUSALS = [
  'no_research_agent',
  'agent_not_active',
  'budget_spent',
  'no_holdings',
  'research_running',
] as const;
export type ResearchRefusal = (typeof RESEARCH_REFUSALS)[number];

/** Why a run stopped before its last holding, in `research_runs.error`; anything else is a failure. */
export const RESEARCH_STOPS = [
  'budget_reached',
  'time_limit',
  'holdings_limit',
  'no_model',
  'own_key_required',
  'own_key_failed',
  'safety_limit_reached',
  'abandoned',
] as const;
export type ResearchStop = (typeof RESEARCH_STOPS)[number];

export interface ResearchAgent {
  id: string;
  name: string;
  state: 'active' | 'paused' | 'archived';
}

export interface ResearchRating {
  rating: SentimentRating;
  /** Model-written, in English (D291), checked by the evidence validator. */
  rationale: string;
  findings: string[];
  agentName: string;
  ratedAt: string;
  /** Older than `RESEARCH_STALE_DAYS`. */
  stale: boolean;
}

export interface ResearchHolding {
  instrumentId: string;
  symbol: string;
  name: string | null;
  /** The assigned agent's latest rating of it; null before its first. */
  latest: ResearchRating | null;
  /** The newest attempt, when it came after `latest` and was not rated. */
  lastAttempt: { status: 'refused' | 'failed'; at: string } | null;
}

export interface ResearchRunSummary {
  id: string;
  trigger: 'manual' | 'schedule';
  status: 'running' | 'done' | 'failed';
  holdings: number;
  rated: number;
  startedAt: string;
  finishedAt: string | null;
  /** A `ResearchStop`, or a failure's English detail; null for a run that rated every holding. */
  error: string | null;
}

/** `GET /api/research`. */
export interface ResearchResponse {
  agent: ResearchAgent | null;
  run: ResearchRunSummary | null;
  holdings: ResearchHolding[];
}

/** `PUT /api/research/agent`: assign one of the user's agents, or none. */
export interface ResearchAgentInput {
  agentId: string | null;
}
