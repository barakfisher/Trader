/**
 * Yahoo's sector, industry and ETF category names in the interface's language (D190-D193).
 *
 * The English name is the identifier: it is what `agents.sectors` stores, what
 * the server checks and enforces, and what the scan's briefing states. Only
 * the web shows these names, so the translations live here, keyed by that
 * name, and change nothing that is stored (D191).
 *
 * Not catalogue keys: names like "Foreign Small/Mid Blend" make poor i18next
 * keys, and English would need 262 entries that say themselves. The parity
 * that `parity.ts` gives the catalogue, `test/taxonomyNames.test.ts` gives
 * this map against the committed universe snapshot.
 *
 * A name the map lacks - a rescreen can bring one before the snapshot is
 * committed again - is shown in English, marked as English (D193).
 */

import { currentLanguage, type Language } from './index.ts';
import he from './taxonomy/he.json';

/** Each language's names, keyed by the English name. English needs none. */
export const TAXONOMY_NAMES: Partial<Record<Language, Readonly<Record<string, string>>>> = { he };

export interface TaxonomyLabel {
  text: string;
  /** 'en' when the text is the English name; undefined when it is in the interface's language. */
  lang: 'en' | undefined;
}

/** How the interface names `name`: translated where it can be, else in English. */
export function taxonomyLabel(name: string, language: Language = currentLanguage()): TaxonomyLabel {
  const translated = TAXONOMY_NAMES[language]?.[name];
  return translated === undefined ? { text: name, lang: 'en' } : { text: translated, lang: undefined };
}

/**
 * The name inside written instructions (D192): the translation with the
 * English name after it - "טכנולוגיה (Technology)" - so the model reading the
 * instructions meets the exact identifier the briefing and the contradiction
 * check use, and a user who edits the text keeps it.
 */
export function taxonomyPhrase(name: string, language: Language = currentLanguage()): string {
  const label = taxonomyLabel(name, language);
  return label.lang === undefined ? `${label.text} (${name})` : name;
}
