/**
 * The languages the web interface is written in: migration 0034's CHECK on
 * `user_settings.language`, restated for the two services that read it. A
 * runtime list, not only a type, because the orchestrator validates a request
 * against it before the database is asked.
 */
export const UI_LANGUAGES = ['en', 'he'] as const;

export type UiLanguage = (typeof UI_LANGUAGES)[number];
