/**
 * Every string a user sees comes from here (CLAUDE.md guideline 1).
 *
 * i18next holds the catalogues; react-i18next re-renders a component when the
 * language changes. This module is the one import path for both - components
 * take `useTranslation`/`Trans` from it, plain code (stores, `lib/`) takes `t` -
 * so whatever imports a translation also initialises the catalogues, in the app
 * and in a test alike.
 *
 * English is the source: `locales/en.json` defines every key, TypeScript types
 * `t()` against it (`i18next.d.ts`), so a mistyped key does not compile, and
 * `test/i18n.test.ts` fails when another language lacks a key English has. A
 * missing translation is therefore a red CI run, never a quiet English word on
 * a Hebrew page.
 *
 * Numbers, money, percents and dates are not catalogue entries: they go
 * through `Intl` in the language's locale (`format.ts`).
 */

import i18n from 'i18next';
import { createAtom } from 'mobx';
import { initReactI18next } from 'react-i18next';

import en from './locales/en.json';

/** The languages the interface is written in. English is the source and the default. */
export const LANGUAGES = ['en'] as const;
export type Language = (typeof LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Language = 'en';

/** Each language's catalogue, keyed as i18next expects: one namespace, `translation`. */
export const CATALOGUES: Record<Language, { translation: typeof en }> = {
  en: { translation: en },
};

void i18n.use(initReactI18next).init({
  lng: DEFAULT_LANGUAGE,
  fallbackLng: DEFAULT_LANGUAGE,
  resources: CATALOGUES,
  // Synchronous: the catalogues are bundled, so the first render already has them.
  initAsync: false,
  // React escapes what it renders; escaping here as well would print "AT&amp;T".
  interpolation: { escapeValue: false },
  returnNull: false,
});

/** The active language; anything i18next reports that is not one of ours is the default. */
export function currentLanguage(): Language {
  const active = i18n.resolvedLanguage ?? i18n.language;
  return (LANGUAGES as readonly string[]).includes(active) ? (active as Language) : DEFAULT_LANGUAGE;
}

/**
 * A record of labels read from the catalogue each time a value is read, for a
 * module-level table such as an outcome's label: built once, it still follows
 * a change of language.
 */
export function translatedRecord<K extends string>(
  keys: readonly K[],
  translate: (key: K) => string,
): Record<K, string> {
  const record = {} as Record<K, string>;
  for (const key of keys) {
    Object.defineProperty(record, key, { enumerable: true, get: () => translate(key) });
  }
  return record;
}

/**
 * The language as a MobX dependency. A store's computed message ("Name the
 * topic.") is cached until something it read changes; reading the language
 * through this atom makes a change of language one of those things, so the
 * cached English is recomputed rather than left on a Hebrew page.
 */
const languageAtom = createAtom('language');
i18n.on('languageChanged', () => languageAtom.reportChanged());

/** Translate outside React - in a store or a `lib/` function. Components use `useTranslation`. */
const translate = i18n.t.bind(i18n) as unknown as (...args: unknown[]) => string;
export const t = ((...args: unknown[]) => {
  languageAtom.reportObserved();
  return translate(...args);
}) as unknown as typeof i18n.t;

export { i18n };
export { Trans, useTranslation } from 'react-i18next';
