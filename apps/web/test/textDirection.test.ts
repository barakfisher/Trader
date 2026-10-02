// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { applyLanguage } from '../src/i18n/index.ts';
import { MIRROR_IN_RTL, applyDocumentDirection, directionOf } from '../src/lib/textDirection.ts';

/**
 * The layout mirrors because it is written in logical terms. One `ml-4` or
 * `text-right` breaks that silently: it looks right in English, which is the
 * only direction anyone looks at by default, and wrong only in the other one.
 * So the physical forms are refused here rather than found on screen.
 */
const PHYSICAL_CLASS = new RegExp(
  [
    String.raw`(?<![\w-])(?:[a-z-]+:)*-?(?:m|p|scroll-m|scroll-p)[lr]-(?:\d|px|auto|\[)`,
    String.raw`(?<![\w-])(?:[a-z-]+:)*-?(?:left|right)-(?:\d|px|full|auto|\[)`,
    String.raw`(?<![\w-])(?:[a-z-]+:)*(?:text|float|clear)-(?:left|right)(?![\w-])`,
    String.raw`(?<![\w-])(?:[a-z-]+:)*rounded-(?:[lr]|[tb][lr])(?![a-z])(?:-[\w./[\]]+)?`,
    String.raw`(?<![\w-])(?:[a-z-]+:)*border-[lr](?![a-z])(?:-[\w./[\]]+)?`,
  ].join('|'),
  'g',
);

/** Icons that point along the reading direction, so must turn around with it. */
const DIRECTIONAL_ICON = /<(ArrowLeft|ArrowRight|ChevronLeft|ChevronRight)\b[^>]*>/g;

const SRC = resolve(import.meta.dirname, '../src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|css)$/.test(entry.name) ? [path] : [];
  });
}

describe('the layout is written in logical directions', () => {
  it('uses no left/right utility classes anywhere in the app', () => {
    const offences = sourceFiles(SRC).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(PHYSICAL_CLASS)].map(
        (match) => `${file.slice(SRC.length + 1)}: ${match[0].trim()}`,
      ),
    );
    expect(offences).toEqual([]);
  });

  it('would catch the forms it was written for', () => {
    const caught = (text: string) => [...text.matchAll(PHYSICAL_CLASS)].map((m) => m[0].trim());
    expect(caught('className="pr-3 text-right ml-auto sm:pl-4 -mr-2 right-0 border-l-2 rounded-l"')).toEqual([
      'pr-3',
      'text-right',
      'ml-auto',
      'sm:pl-4',
      '-mr-2',
      'right-0',
      'border-l-2',
      'rounded-l',
    ]);
    // ...and not their logical forms, nor prose about directions.
    expect(caught('className="pe-3 text-end ms-auto rounded-lg border-b" a right-to-left page')).toEqual([]);
  });

  it('mirrors every icon that points along the reading direction', () => {
    const unmirrored = sourceFiles(SRC).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(DIRECTIONAL_ICON)]
        .filter((match) => !match[0].includes('MIRROR_IN_RTL'))
        .map((match) => `${file.slice(SRC.length + 1)}: ${match[0]}`),
    );
    expect(unmirrored).toEqual([]);
    expect(MIRROR_IN_RTL).toMatch(/^rtl:/);
  });
});

describe('the page direction', () => {
  it('is the language\'s: Hebrew reads right to left, English left to right', () => {
    expect(directionOf('he')).toBe('rtl');
    expect(directionOf('en')).toBe('ltr');
  });

  it('is set on <html>, which every logical class and rtl: variant follows', () => {
    applyDocumentDirection('rtl');
    expect(document.documentElement.dir).toBe('rtl');
    applyDocumentDirection('ltr');
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('changes with the language, together with lang, so neither is left behind', () => {
    applyLanguage('he');
    expect(document.documentElement.lang).toBe('he');
    expect(document.documentElement.dir).toBe('rtl');
    applyLanguage('en');
    expect(document.documentElement.lang).toBe('en');
    expect(document.documentElement.dir).toBe('ltr');
  });
});
