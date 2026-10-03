/**
 * Which way the page reads, and the few places that must not follow it.
 *
 * The layout is written in logical terms - `ms-`/`pe-`/`text-end`, never their
 * left/right forms (`test/textDirection.test.ts` refuses those) - so one `dir`
 * attribute on `<html>` mirrors every page. The direction is the language's
 * (`directionOf`), set with it by `applyLanguage` in `i18n/index.ts`. Slice 1's
 * `?dir=rtl` test switch is gone with the setting that replaced it: a switch
 * that outlives its purpose is how a tab ends up mirrored in English.
 */

export type TextDirection = 'ltr' | 'rtl';

/** The languages written right to left. Every other one reads left to right. */
const RIGHT_TO_LEFT = new Set(['he']);

export function directionOf(language: string): TextDirection {
  return RIGHT_TO_LEFT.has(language) ? 'rtl' : 'ltr';
}

/** Set `dir` on `<html>`: every logical class, and every `rtl:` variant, follows it. */
export function applyDocumentDirection(direction: TextDirection, root: HTMLElement = document.documentElement): void {
  root.dir = direction;
}

/**
 * Text the server wrote in English - `/ask` answers, the concept corpus, news
 * headlines, and an observation with no translation (`observationText`). The interface
 * around it may be translated; this text is not (CLAUDE.md guideline 1), so it
 * says so: `lang="en"` for screen readers and hyphenation, and `dir="auto"` so
 * an English sentence keeps its own direction - and its full stop and minus
 * signs where they belong - on a right-to-left page. Spread onto the element
 * that holds the text: `<p {...SERVER_ENGLISH}>`.
 */
export const SERVER_ENGLISH = { lang: 'en', dir: 'auto' } as const;

/**
 * Icons that point along the reading direction - back, forward, a collapsed
 * row - turn around on a right-to-left page. Icons that point up or down, or
 * at nothing, do not; neither do charts, whose time axis runs left to right
 * in either direction (`CHART_DIRECTION`).
 */
export const MIRROR_IN_RTL = 'rtl:-scale-x-100';

/**
 * Charts keep time running left to right on a right-to-left page, the usual
 * convention for financial charts in Hebrew interfaces: a price history drawn
 * backwards reads as its own mirror image. Recharts has no right-to-left mode,
 * so the chart's box is pinned.
 */
export const CHART_DIRECTION = 'ltr' satisfies TextDirection;
