import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { NARROW_QUERY } from '../src/lib/viewport.ts';

/**
 * A phone's text and tap sizes live in one rule of `index.css` (D384). jsdom has
 * no layout and no media queries, so what can be held here is that the rule
 * applies where the phone layout does, and that no new text escapes the scale.
 */
const SRC = resolve(import.meta.dirname, '../src');
const css = readFileSync(resolve(SRC, 'index.css'), 'utf8');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.tsx') ? [path] : [];
  });
}

describe("a phone's sizes", () => {
  it('are set at the width the phone layout starts', () => {
    const rule = css.slice(css.indexOf('@media', css.indexOf("A phone's sizes")));
    expect(rule.startsWith(`@media ${NARROW_QUERY}`)).toBe(true);
  });

  it('cannot be missed by a size written by hand', () => {
    const offences = sourceFiles(SRC).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/\btext-\[\d+(?:\.\d+)?(?:px|rem)\]/g)].map(
        (match) => `${file.slice(SRC.length + 1)}: ${match[0]}`,
      ),
    );
    expect(offences).toEqual([]);
  });
});
