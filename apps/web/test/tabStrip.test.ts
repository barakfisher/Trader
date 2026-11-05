import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A tab strip scrolls sideways, and its tabs overlap its border with `-mb-px`.
 * `overflow-x-auto` alone makes the other axis `auto` too, so that one pixel
 * becomes a vertical scroll, with a scrollbar at the strip's end. jsdom has no
 * layout to measure that in, so the class is required on the source.
 */
const PAGES = resolve(import.meta.dirname, '../src/pages');

describe('a tab strip', () => {
  it('scrolls sideways and never vertically', () => {
    const strips = readdirSync(PAGES)
      .filter((name) => name.endsWith('.tsx'))
      .flatMap((name) =>
        [...readFileSync(resolve(PAGES, name), 'utf8').matchAll(/role="tablist"[^>]*overflow-x-auto[^>]*>/g)].map(
          (match) => ({ name, tag: match[0] }),
        ),
      );
    expect(strips.map((strip) => strip.name).sort()).toEqual(['AdminPage.tsx', 'AgentPage.tsx', 'InsightsPage.tsx']);
    for (const strip of strips) expect(strip.tag).toContain('overflow-y-hidden');
  });
});
