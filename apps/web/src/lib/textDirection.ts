/**
 * Which way the page reads, and the few places that must not follow it.
 *
 * The layout is written in logical terms - `ms-`/`pe-`/`text-end`, never their
 * left/right forms (`test/textDirection.test.ts` refuses those) - so one `dir`
 * attribute on `<html>` mirrors every page. Until the language setting exists
 * the direction is always left-to-right, except when `?dir=rtl` asks for the
 * mirror: that is how a page is checked in both directions before there is any
 * Hebrew to read.
 */

export type TextDirection = 'ltr' | 'rtl';

const OVERRIDE_KEY = 'traders.dir';

/** `?dir=rtl` or `?dir=ltr` from a query string; anything else is no override. */
export function directionFromQuery(search: string): TextDirection | null {
  const value = new URLSearchParams(search).get('dir');
  return value === 'rtl' || value === 'ltr' ? value : null;
}

/**
 * The direction to start in: an override from the address, remembered for the
 * tab so that a full reload or a link opened in place keeps the mirror on, and
 * left-to-right otherwise. Storage can be unavailable (a private window); the
 * override then lasts for this load only, which is the safe way to lose it.
 */
export function initialDirection(search: string, storage: Storage | null = sessionStorageOrNull()): TextDirection {
  const fromQuery = directionFromQuery(search);
  if (fromQuery !== null) {
    try {
      storage?.setItem(OVERRIDE_KEY, fromQuery);
    } catch {
      // Not remembered; this load still honours it.
    }
    return fromQuery;
  }
  try {
    const remembered = storage?.getItem(OVERRIDE_KEY);
    if (remembered === 'rtl' || remembered === 'ltr') return remembered;
  } catch {
    // Unreadable storage is the same as no override.
  }
  return 'ltr';
}

/** Set `dir` on `<html>`: every logical class, and every `rtl:` variant, follows it. */
export function applyDocumentDirection(direction: TextDirection, root: HTMLElement = document.documentElement): void {
  root.dir = direction;
}

function sessionStorageOrNull(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Text the server wrote in English - observation headlines and explanations,
 * narration, `/ask` answers, the concept corpus, news headlines. The interface
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
