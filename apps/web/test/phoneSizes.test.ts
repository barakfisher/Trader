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

const ROOT_PX = 16;
/** What was agreed with the user for D384. */
const TAP_PX = 44;
const SMALLEST_TEXT_PX = 12;

const phoneRule = () => css.slice(css.indexOf('@media', css.indexOf("A phone's sizes")));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.tsx') ? [path] : [];
  });
}

describe("a phone's sizes", () => {
  it('are set at the width the phone layout starts', () => {
    expect(phoneRule().startsWith(`@media ${NARROW_QUERY}`)).toBe(true);
  });

  it('raise every small step of the scale to a readable size', () => {
    const rule = phoneRule();
    for (const step of ['--text-3xs', '--text-2xs', '--text-xs', '--text-sm']) {
      const size = new RegExp(`${step}: ([\\d.]+)rem`).exec(rule)?.[1];
      expect(Number(size) * ROOT_PX, step).toBeGreaterThanOrEqual(SMALLEST_TEXT_PX);
    }
  });

  it('hold a control and its hidden target to a thumb', () => {
    const rule = phoneRule();
    expect(rule).toMatch(/button,\s+select,\s+input:not\([^)]*\)[^{]*\{\s*min-height: 2\.75rem/);
    expect(rule).toMatch(/\.tap-compact::after \{[^}]*var\(--tap-size, 2\.75rem\)/);
    expect(2.75 * ROOT_PX).toBe(TAP_PX);
  });

  it('cannot be missed by a size written by hand', () => {
    const offences = sourceFiles(SRC).flatMap((file) =>
      [
        ...readFileSync(file, 'utf8').matchAll(/\btext-\[\d+(?:\.\d+)?(?:px|rem)\]|\bfontSize: \d+/g),
      ].map((match) => `${file.slice(SRC.length + 1)}: ${match[0]}`),
    );
    expect(offences).toEqual([]);
  });
});
