/**
 * What each narration state means to a reader, and what they can do about it.
 *
 * Copy rather than component code, for the same reason `severityScale.ts` is:
 * these sentences are the entire value of the indicator. A badge that says
 * "degraded" tells a reader they have a problem and not which one, and the
 * three problems here have three unrelated remedies.
 *
 * The monthly estimate is measured, not guessed: recorded spend was $0.01518
 * across the ten narrations of one day, so roughly $0.0015 each, and this
 * portfolio produces about ten new findings a day. It is stated as an
 * approximation because it scales with how much the holdings move, which is not
 * something this page can promise.
 */

import type { NarrationHealthResponse, NarrationState, NarrationTier } from '@traders/shared';

import { t } from '../i18n/index.ts';

export interface NarrationCopy {
  /** Two or three words, for the badge itself. */
  label: string;
  /** One sentence: what is true right now. */
  summary: string;
  /** What a reader loses, in plain terms. Null when they lose nothing. */
  consequence: string | null;
  /** How loud the badge should be. */
  tone: 'neutral' | 'warn' | 'loss';
}

/** How loud each state's badge is; the words are in the catalogue (`narration.states`). */
const TONES: Record<NarrationState, NarrationCopy['tone']> = {
  narrating: 'neutral',
  off: 'neutral',
  rejected: 'warn',
  exhausted: 'warn',
  unavailable: 'warn',
  unknown: 'neutral',
};

export function describeNarration(state: NarrationState): NarrationCopy {
  return {
    label: t(`narration.states.${state}.label`),
    summary: t(`narration.states.${state}.summary`),
    // A model narrating normally costs the reader nothing, so it has nothing to say here.
    consequence: state === 'narrating' ? null : t(`narration.states.${state}.consequence`),
    tone: TONES[state],
  };
}

/** The two ways out, in the order a reader would weigh them. */
export interface NarrationOption {
  title: string;
  detail: string;
}

/**
 * A pair, not a list. There are exactly two ways out - pay for a model that can
 * hold the constraint, or keep the templates that already do - and typing it as
 * a tuple means a caller reading `[1]` is reading something that exists.
 */
export function narrationOptions(tier: NarrationTier): readonly [NarrationOption, NarrationOption] {
  return [
    {
      title: t('narration.fund.title'),
      detail: tier === 'free' ? t('narration.fund.detailFree') : t('narration.fund.detailPaid'),
    },
    {
      title: t('narration.templates.title'),
      detail: t('narration.templates.detail'),
    },
  ] as const;
}

/**
 * Whether the badge is worth showing at all.
 *
 * `narrating` on a paid model is the expected state and says nothing a reader
 * needs - a badge that is always present stops being read. Every other state
 * is either a cost the reader is paying in quality, or a fact about the bill.
 */
export function isNoteworthy(health: NarrationHealthResponse | undefined): boolean {
  if (health === undefined) return false;
  return health.state !== 'narrating' || health.tier !== 'paid';
}
