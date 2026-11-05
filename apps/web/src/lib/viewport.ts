/**
 * Whether the screen is phone-narrow, for the few places whose layout differs
 * in *structure* rather than in spacing - a table that becomes cards.
 *
 * Structure is chosen in JavaScript rather than by rendering both and hiding
 * one with CSS: rendering both puts every holding in the page twice, so a
 * screen reader in some setups and every DOM test would find two of each link.
 * Without `matchMedia` (a test's jsdom) the answer is "not narrow": the desktop
 * layout, which is what the existing tests describe.
 */

import { useEffect, useState } from 'react';

/** Tailwind's `sm` breakpoint: below it is a phone. */
export const NARROW_QUERY = '(max-width: 639px)';

/**
 * Tailwind's `md` breakpoint: below it the places are on the bottom bar (D382).
 * Wider than a phone on purpose: it is where the header's row of places stops
 * fitting, so no width shows a place twice or not at all.
 */
export const BOTTOM_BAR_QUERY = '(max-width: 767px)';

function matches(media: string): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(media).matches
    : false;
}

function useMediaQuery(media: string): boolean {
  const [matched, setMatched] = useState(() => matches(media));
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(media);
    const update = () => setMatched(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, [media]);
  return matched;
}

export function useNarrowViewport(): boolean {
  return useMediaQuery(NARROW_QUERY);
}

export function useBottomBarViewport(): boolean {
  return useMediaQuery(BOTTOM_BAR_QUERY);
}
