/**
 * The words of a narration notice, and how loud it is.
 *
 * Its own module because two places say it: `narrationWatch.ts` when a
 * transition is announced, and the digest when one was deferred. The sentences
 * follow the Settings badge's copy (`apps/web/src/lib/narrationStatus.ts`), so a
 * message and the badge agree about the remedy.
 *
 * Fixed sentences with no figures in them: nothing here goes through the
 * evidence validator, so nothing here may be a number. The sentences
 * themselves are in `notify/messages.ts`, in every interface language.
 */

import { UI_LANGUAGES, type LocalizedTexts } from '@traders/shared';

import { messagesFor, type RecordedNarrationState } from '../notify/messages.js';

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

/** The notice for arriving in `toState`, in `language` (English by default). */
export function announcementFor(toState: string, language: string = 'en'): NarrationNotice {
  const messages = messagesFor(language);
  const copy = messages.narration[toState as RecordedNarrationState] ?? messages.narrationFallback;
  return {
    severity: byModel(toState) || toState === 'off' ? RECOVERY_SEVERITY : BREAK_SEVERITY,
    ...copy,
  };
}

/**
 * The notice in every language besides English, in the shape an observation's
 * translations take (`LocalizedTexts`), so a notice reaches a Hebrew chat the
 * same way a finding does.
 */
export function localizedAnnouncement(toState: string): LocalizedTexts {
  const localized: LocalizedTexts = {};
  for (const language of UI_LANGUAGES) {
    if (language === 'en') continue;
    const { headline, explanation } = announcementFor(toState, language);
    localized[language] = { headline, explanation };
  }
  return localized;
}
