/**
 * Research on the main portfolio as the browser sees it (D254, D289-D293, D392):
 * the agent assigned to it, its latest run, and each holding's latest rating.
 *
 * Since D392 a rating is the agent's view, like an advisor's: Buy more / Hold /
 * Trim / Sell on a holding, Buy / Wait / Avoid on a stock researched on its own.
 * The research page carries the not-advice line, and the *Rating* column always
 * shows the word beside its colour (D254's guardrails 4 and 5).
 */

/** What a holding is rated (D392). */
export const HELD_RATINGS = ['buy_more', 'hold', 'trim', 'sell'] as const;
/** What a stock the real portfolio does not hold is rated (D369, D392). */
export const UNHELD_RATINGS = ['buy', 'wait', 'avoid'] as const;
/** Stored before D392, shown until a newer rating replaces them. */
export const LEGACY_RATINGS = ['bullish', 'bearish', 'neutral'] as const;
/** `0085_research_advice.RATINGS`; the AI service's `rating.RATINGS` says the same. */
export const RESEARCH_RATINGS = [...HELD_RATINGS, ...UNHELD_RATINGS, ...LEGACY_RATINGS] as const;
export type RatingWord = (typeof RESEARCH_RATINGS)[number];

/** A rating stored before D392: its rationale is in English. */
export function isLegacyRating(rating: string): boolean {
  return (LEGACY_RATINGS as readonly string[]).includes(rating);
}

/**
 * The ratings that ask for an action and so raise an acknowledge-only proposal
 * on the real portfolio (D392); the AI service's `ACTIONABLE_RATINGS` says the same.
 * Hold, Wait and Avoid are a bottom line on the research page only.
 */
export const ACTIONABLE_RATINGS = ['buy_more', 'trim', 'sell', 'buy'] as const;
export type ActionableRating = (typeof ACTIONABLE_RATINGS)[number];

export function isActionableRating(rating: string): rating is ActionableRating {
  return (ACTIONABLE_RATINGS as readonly string[]).includes(rating);
}

/**
 * The proposal kind a research view raises on the real portfolio (0085, D392):
 * acknowledged, never filled - approving it changes no holding.
 */
export const RESEARCH_PROPOSAL_KIND = 'research';

/** A `research` proposal's `payload`: the view, and the rating it came from. No quantity, no price. */
export interface ResearchProposalPayload {
  action: ActionableRating;
  symbol: string;
  instrumentId: string;
  /** The `research_ratings` row: its rationale, findings and evidence. */
  ratingId: string;
  /** The research agent that gave the view, named on every surface (D387). */
  researchAgentId: string;
  researchAgentName: string;
}

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
  rating: RatingWord;
  /** Model-written, in the user's language since D392 (English before), checked by the evidence validator. */
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
  /** In the main portfolio; false for a stock researched on its own from its row (D370). */
  held: boolean;
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
/** `POST /research/runs`: absent, every holding; with an instrument, that one stock (D369). */
export interface ResearchRunInput {
  instrumentId?: string;
}

export interface ResearchAgentInput {
  agentId: string | null;
}
