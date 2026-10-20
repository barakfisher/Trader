/**
 * The languages the web interface is written in: migration 0034's CHECK on
 * `user_settings.language`, restated for the two services that read it. A
 * runtime list, not only a type, because the orchestrator validates a request
 * against it before the database is asked.
 */
export const UI_LANGUAGES = ['en', 'he'] as const;

export type UiLanguage = (typeof UI_LANGUAGES)[number];

/**
 * The languages an observation is stored in besides English. English is its own
 * `headline` and `explanation`; every other language is the template's wording,
 * rendered when the observation is written (`app/narration/localized.py`).
 */
export type TranslatedLanguage = Exclude<UiLanguage, 'en'>;

/** An observation's words in one language. */
export interface LocalizedText {
  headline: string;
  explanation: string;
}

/**
 * `observations.localized`. A language missing from it has no translation, and
 * the English beside it is the answer - never a blank.
 */
export type LocalizedTexts = Partial<Record<TranslatedLanguage, LocalizedText>>;

/** A Hebrew letter, alef to tav. Points and punctuation are not needed to tell. */
const HEBREW_LETTER = /[א-ת]/;

/**
 * The interface language a piece of text is written in, for words that answer
 * it (D224): Hebrew when it has a Hebrew letter, otherwise English. Only the two
 * languages the app ships; a ticker or a figure in a Hebrew sentence leaves it
 * Hebrew, and a question with no letters at all ("?", "NVDA") is English.
 */
export function writtenLanguage(text: string): UiLanguage {
  return HEBREW_LETTER.test(text) ? 'he' : 'en';
}
