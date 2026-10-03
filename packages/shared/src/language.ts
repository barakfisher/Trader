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
