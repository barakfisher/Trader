/**
 * What an `/ask` reply says about itself, in words.
 *
 * Four refusals and a weak match must stay distinguishable on screen (decisions
 * 32 and 36): "the corpus does not cover that", "your portfolio did not load",
 * "that is advice" and "that is not arithmetic" call for four different next
 * steps, and a reader told the wrong one is misled about what went wrong. So
 * each has its own title, and anything unknown is named as unknown rather than
 * folded into one of them.
 */

import type { AskResponse } from '@traders/shared/ai';

export type AskOutcome =
  | { kind: 'answer'; relevance: 'confident' | 'weak' }
  | { kind: 'computed' }
  | { kind: 'refused'; title: string; reason: string };

const REFUSAL_TITLES: Record<string, string> = {
  not_in_corpus: 'Not in the reference corpus',
  no_holdings: 'No holdings to compute from',
  advice: 'No personal investment advice',
  not_computable: 'Not something I can compute',
};

export function outcomeOf(response: AskResponse): AskOutcome {
  if (!response.answered) {
    const reason = response.refused_reason ?? 'unknown';
    return { kind: 'refused', reason, title: REFUSAL_TITLES[reason] ?? `Not answered (${reason})` };
  }
  if (response.answer_source === 'computed') return { kind: 'computed' };
  return { kind: 'answer', relevance: response.relevance === 'weak' ? 'weak' : 'confident' };
}

/** What the portfolio half can compute: said when it declines, so the reader knows what to ask. */
export const COMPUTABLE_QUESTIONS = [
  'what your portfolio is worth',
  'your largest and smallest position',
  'how far your weights sit from your targets',
];

/**
 * Why a model's draft was not used, when one was attempted. `none` and
 * `no_llm_configured` say nothing: no draft was set aside.
 */
function setAsideReason(reason: string): string | null {
  switch (reason) {
    case 'none':
    case 'no_llm_configured':
      return null;
    case 'unsourced_figures':
      return 'it stated a figure the passages do not contain';
    case 'degenerate_completion':
      return 'it was not readable text';
    case 'empty_completion':
      return 'it came back empty';
    case 'LLMBudgetExceededError':
      return 'today’s model budget is spent';
    case 'LLMTimeoutError':
      return 'the model did not answer in time';
    default:
      return 'the model could not be reached';
  }
}

/** Who wrote the answer, and what was checked. Never blank for an answer. */
export function sourceText(response: AskResponse): string {
  switch (response.answer_source) {
    case 'llm':
      return 'Written by a model from the passages below. Every figure in it was checked against them.';
    case 'computed':
      return 'Computed from your holdings. No model wrote this.';
    case 'extractive': {
      const aside = setAsideReason(response.fallback_reason ?? 'none');
      return aside
        ? `Quoted from the passages below. A model’s draft was set aside: ${aside}.`
        : 'Quoted from the passages below.';
    }
    default:
      return '';
  }
}

/**
 * Said when the embedder matches shared words rather than meaning (the keyless
 * fixture): the relevance floor abstains there, so "confident" means less.
 */
export function matchingNote(response: AskResponse): string | null {
  // Only a concept answer searched the corpus; arithmetic over holdings matched nothing.
  return response.vector_is_semantic || response.intent !== 'concept'
    ? null
    : 'Matched on shared words, not meaning: no semantic embedder is configured here, so the relevance check is not applied.';
}

/** A similarity for display: two places, cut on the digits. */
export function similarityText(similarity: number | null | undefined): string | null {
  if (similarity === null || similarity === undefined) return null;
  return (Math.trunc(similarity * 100) / 100).toFixed(2);
}

/** What the page says while waiting, by how long it has waited. */
export function waitingText(seconds: number): string {
  if (seconds < 3) return 'Searching the reference corpus…';
  return `Still working (${seconds}s). When a model writes the answer from the passages, this can take a minute or more.`;
}
