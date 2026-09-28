/**
 * The words of a narration notice, and how loud it is.
 *
 * Its own module because two places say it: `narrationWatch.ts` when a
 * transition is announced, and the digest when one was deferred. The sentences
 * follow the Settings badge's copy (`apps/web/src/lib/narrationStatus.ts`), so a
 * message and the badge agree about the remedy.
 *
 * Fixed sentences with no figures in them: nothing here goes through the
 * evidence validator, so nothing here may be a number.
 */

import type { NarrationState } from './narrationHealth.js';

/** Severity of a switch to templates: pushes past the default `high` floor. */
export const BREAK_SEVERITY = 'high';

/**
 * Severity of a switch back to the model, or to deliberately off: below the
 * default floor, so it waits for the digest. Breaking interrupts and recovering
 * does not - the user's decision, 2026-09-28.
 */
export const RECOVERY_SEVERITY = 'info';

/** Is the model writing the explanations in this state? */
export function byModel(state: string): boolean {
  return state === 'narrating';
}

export interface NarrationNotice {
  severity: string;
  headline: string;
  explanation: string;
}

type RecordedState = Exclude<NarrationState, 'unknown'>;

const COPY: Record<RecordedState, { headline: string; explanation: string }> = {
  narrating: {
    headline: 'Explanations are written by the model again',
    explanation:
      'New findings are explained in their own terms again, and every figure is still checked against the evidence before it is stored.',
  },
  off: {
    headline: 'Explanations are written by templates: no model is configured',
    explanation:
      'Every figure is still checked and still correct; the phrasing is fixed. This is a configuration, not a fault.',
  },
  rejected: {
    headline: 'Explanations fell back to templates: the model output was refused',
    explanation:
      'The model is answering, and its sentences contain figures that are not in the evidence, so templates are used instead and nothing wrong reached you. A more capable model is the fix; waiting is not.',
  },
  exhausted: {
    headline: 'Explanations fell back to templates: the spend ceiling was reached',
    explanation:
      'The model calls were stopped by the budget. Templates are used until the ceiling resets or is raised.',
  },
  unavailable: {
    headline: 'Explanations fell back to templates: the model is unavailable',
    explanation:
      'The provider refused or failed the recent requests. Templates are used meanwhile; this often clears by itself.',
  },
};

/** The notice for arriving in `toState`. */
export function announcementFor(toState: string): NarrationNotice {
  const copy = COPY[toState as RecordedState] ?? {
    // A state added to NarrationState without copy here should still say
    // something true rather than nothing.
    headline: 'Explanations changed how they are written',
    explanation: 'Every figure in them is still checked against the evidence before it is shown.',
  };
  return {
    severity: byModel(toState) || toState === 'off' ? RECOVERY_SEVERITY : BREAK_SEVERITY,
    ...copy,
  };
}
