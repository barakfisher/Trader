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

import { formatFixed } from '../i18n/format.ts';
import { i18n, t } from '../i18n/index.ts';

export type AskOutcome =
  | { kind: 'answer'; relevance: 'confident' | 'weak' }
  | { kind: 'computed' }
  | { kind: 'refused'; title: string; reason: string };

function refusalTitle(reason: string): string {
  return i18n.exists(`ask.refusals.${reason}`)
    ? t(`ask.refusals.${reason as 'advice'}`)
    : t('ask.notAnswered', { reason });
}

export function outcomeOf(response: AskResponse): AskOutcome {
  if (!response.answered) {
    const reason = response.refused_reason ?? 'unknown';
    return { kind: 'refused', reason, title: refusalTitle(reason) };
  }
  if (response.answer_source === 'computed') return { kind: 'computed' };
  return { kind: 'answer', relevance: response.relevance === 'weak' ? 'weak' : 'confident' };
}

/** What the portfolio half can compute: said when it declines, so the reader knows what to ask. */
export function computableQuestions(): string[] {
  return [t('ask.computable.worth'), t('ask.computable.positions'), t('ask.computable.targets')];
}

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
    case 'degenerate_completion':
    case 'empty_completion':
      return t(`ask.setAside.${reason}`);
    case 'LLMBudgetExceededError':
      return t('ask.setAside.budget');
    case 'LLMTimeoutError':
      return t('ask.setAside.timeout');
    default:
      return t('ask.setAside.unreachable');
  }
}

/** Who wrote the answer, and what was checked. Never blank for an answer. */
export function sourceText(response: AskResponse): string {
  switch (response.answer_source) {
    case 'llm':
      return t('ask.source.llm');
    case 'computed':
      return t('ask.source.computed');
    case 'extractive': {
      const aside = setAsideReason(response.fallback_reason ?? 'none');
      return aside ? t('ask.source.extractiveSetAside', { reason: aside }) : t('ask.source.extractive');
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
    : t('ask.lexicalMatching');
}

/** A similarity for display: two places, cut on the digits. */
export function similarityText(similarity: number | null | undefined): string | null {
  if (similarity === null || similarity === undefined) return null;
  return formatFixed(Math.trunc(similarity * 100) / 100, 2);
}

/** What the page says while waiting, by how long it has waited. */
export function waitingText(seconds: number): string {
  if (seconds < 3) return t('ask.searching');
  return t('ask.stillWorking', { seconds });
}
