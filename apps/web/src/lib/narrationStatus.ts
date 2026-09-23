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

import type { NarrationState, NarrationTier } from '@traders/shared';

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

const COPY: Record<NarrationState, NarrationCopy> = {
  narrating: {
    label: 'Explanations by model',
    summary: 'A model is writing the explanations, and every figure in them is checked against the evidence before it is stored.',
    consequence: null,
    tone: 'neutral',
  },
  off: {
    label: 'Explanations by template',
    summary: 'No language model is configured, so explanations are written from fixed templates.',
    consequence: 'Every figure is still checked and still correct. The phrasing is fixed, and a finding cannot be described in its own terms.',
    tone: 'neutral',
  },
  rejected: {
    label: 'Model output refused',
    summary: 'The model is answering, and its sentences are being refused because they contain figures that are not in the evidence.',
    consequence: 'Templates are used instead, so nothing wrong has been shown to you - the refusal is the safeguard working. A more capable model is the only thing that changes this; waiting will not, and neither will paying for this one.',
    tone: 'warn',
  },
  exhausted: {
    label: 'Budget spent',
    summary: 'The daily spend ceiling stopped the model calls.',
    consequence: 'Explanations fall back to templates until the ceiling resets or is raised.',
    tone: 'warn',
  },
  unavailable: {
    label: 'Model unavailable',
    summary: 'The provider refused the last requests. On a free route this usually means the shared pool is busy.',
    consequence: 'Templates are used meanwhile. This often clears by itself.',
    tone: 'warn',
  },
  unknown: {
    label: 'Not recorded',
    summary: 'Nothing has been recorded about how the recent explanations were written.',
    consequence: 'Observations written before this was tracked do not say who wrote them, and are shown as they are rather than guessed at.',
    tone: 'neutral',
  },
};

export function describeNarration(state: NarrationState): NarrationCopy {
  return COPY[state];
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
      title: 'Fund the model — about $0.45 a month',
      detail:
        tier === 'free'
          ? 'Measured from real usage: roughly $0.0015 per explanation, and about ten new findings a day. A capable model restates the evidence without deriving figures of its own, which is what the free one cannot do.'
          : 'Measured from real usage: roughly $0.0015 per explanation, and about ten new findings a day. The figure moves with how much the holdings move.',
    },
    {
      title: 'Stay on templates — no cost, no change needed',
      detail:
        'Fixed phrasing over the same checked figures. Nothing is ever wrong and nothing is ever invented; what is lost is prose that can describe an unusual finding in its own words rather than in a sentence written in advance.',
    },
  ] as const;
}
