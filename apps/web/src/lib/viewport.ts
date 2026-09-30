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

function matches(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(NARROW_QUERY).matches
    : false;
}

export function useNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState(matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(NARROW_QUERY);
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return narrow;
}
