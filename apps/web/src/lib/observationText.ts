import type { LocalizedTexts, TranslatedLanguage } from '@traders/shared';

import { SERVER_ENGLISH } from './textDirection.ts';

/**
 * An observation's words in the page's language, and the attributes that say
 * which language they are in.
 *
 * English is the observation's own `headline` and `explanation`, whoever wrote
 * them. Every other language is the template's wording, stored beside it when
 * the observation was written (`observations.localized`, decision 98) - so on a
 * Hebrew page a model-written finding reads as its plainer template, with the
 * same checked figures. A language the observation has no translation for gets
 * the English, marked `SERVER_ENGLISH` as before: never a blank.
 *
 * The translated text needs no `dir`: it is in the page's own language and
 * direction, and its figures carry their own left-to-right isolates.
 */
export function observationText<T extends { headline: string | null; explanation?: string | null }>(
  observation: T & { localized: LocalizedTexts },
  language: string,
): { headline: T['headline']; explanation: T['explanation']; attributes: { lang: string; dir?: 'auto' } } {
  const translated = language === 'en' ? undefined : observation.localized[language as TranslatedLanguage];
  if (translated !== undefined) {
    return { headline: translated.headline, explanation: translated.explanation, attributes: { lang: language } };
  }
  return { headline: observation.headline, explanation: observation.explanation, attributes: SERVER_ENGLISH };
}
