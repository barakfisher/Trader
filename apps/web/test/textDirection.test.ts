// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  MIRROR_IN_RTL,
  applyDocumentDirection,
  directionFromQuery,
  initialDirection,
} from '../src/lib/textDirection.ts';

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
  function memoryStorage(): Storage {
    const values = new Map<string, string>();
    return {
      get length() {
        return values.size;
      },
      clear: () => values.clear(),
      getItem: (key) => values.get(key) ?? null,
      key: (index) => [...values.keys()][index] ?? null,
      removeItem: (key) => void values.delete(key),
      setItem: (key, value) => void values.set(key, value),
    };
  }

  it('reads an override only for the two directions there are', () => {
    expect(directionFromQuery('?dir=rtl')).toBe('rtl');
    expect(directionFromQuery('?view=x&dir=ltr')).toBe('ltr');
    expect(directionFromQuery('?dir=RTL')).toBeNull();
    expect(directionFromQuery('')).toBeNull();
  });

  it('is left-to-right unless asked otherwise', () => {
    expect(initialDirection('', memoryStorage())).toBe('ltr');
    expect(initialDirection('', null)).toBe('ltr');
  });

  it('remembers an override for the tab, so a reload keeps the mirror on', () => {
    const storage = memoryStorage();
    expect(initialDirection('?dir=rtl', storage)).toBe('rtl');
    expect(initialDirection('', storage)).toBe('rtl');
    expect(initialDirection('?dir=ltr', storage)).toBe('ltr');
    expect(initialDirection('', storage)).toBe('ltr');
  });

  it('still honours an override when storage refuses it', () => {
    const refusing = memoryStorage();
    refusing.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    refusing.getItem = () => {
      throw new Error('SecurityError');
    };
    expect(initialDirection('?dir=rtl', refusing)).toBe('rtl');
    expect(initialDirection('', refusing)).toBe('ltr');
  });

  it('is set on <html>, which every logical class and rtl: variant follows', () => {
    applyDocumentDirection('rtl');
    expect(document.documentElement.dir).toBe('rtl');
    applyDocumentDirection('ltr');
    expect(document.documentElement.dir).toBe('ltr');
  });
});
