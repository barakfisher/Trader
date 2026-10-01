import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { formatMoney, formatNumber, formatPercent, formatShare } from '../src/i18n/format.ts';
import { CATALOGUES, DEFAULT_LANGUAGE, LANGUAGES, i18n, t } from '../src/i18n/index.ts';
import { catalogueProblems, flatten, slots } from '../src/i18n/parity.ts';

const english = CATALOGUES[DEFAULT_LANGUAGE].translation;

describe('every language has what English has', () => {
  it('finds no gap between the English catalogue and any other', () => {
    const catalogues: Record<string, { translation: typeof english }> = CATALOGUES;
    const problems = LANGUAGES.filter((language) => language !== DEFAULT_LANGUAGE).flatMap(
      (language: string) => catalogueProblems(english, catalogues[language]!.translation, language),
    );
    expect(problems).toEqual([]);
  });

  // The check above passes trivially until a second language exists, so the
  // checker itself is tested against catalogues built to fail it.
  const source = {
    title: 'Holdings ({{count}})',
    findings_one: '{{count}} finding',
    findings_other: '{{count}} findings',
    unpriced: 'No provider could price <strong>{{symbols}}</strong>.',
  };

  it('accepts a complete translation, with every plural form the language has', () => {
    const hebrew = {
      title: 'אחזקות ({{count}})',
      findings_one: 'ממצא אחד',
      findings_two: 'שני ממצאים',
      findings_other: '{{count}} ממצאים',
      unpriced: 'אין ספק שתמחר את <strong>{{symbols}}</strong>.',
    };
    expect(catalogueProblems(source, hebrew, 'he')).toEqual([]);
  });

  it('reports a missing key, a missing plural form and a stale key', () => {
    const hebrew = {
      findings_one: 'ממצא אחד',
      findings_other: '{{count}} ממצאים',
      unpriced: 'אין ספק שתמחר את <strong>{{symbols}}</strong>.',
      removedLongAgo: 'ישן',
    };
    expect(catalogueProblems(source, hebrew, 'he')).toEqual([
      'he: missing "title"',
      'he: missing "findings_two"',
      'he: "removedLongAgo" is not in the English catalogue',
    ]);
  });

  it('reports a translation that drops a placeholder or a tag', () => {
    const hebrew = {
      title: 'אחזקות',
      findings_one: 'ממצא אחד',
      findings_two: 'שני ממצאים',
      findings_other: '{{count}} ממצאים',
      unpriced: 'אין ספק שתמחר את {{symbols}}.',
    };
    expect(catalogueProblems(source, hebrew, 'he')).toEqual([
      'he: "title" uses nothing, English uses {{count}}',
      'he: "unpriced" uses {{symbols}}, English uses <strong> {{symbols}}',
    ]);
  });

  it('reads placeholders and tags the way i18next and <Trans> do', () => {
    expect(slots('<delta>{{change}} ({{percent}})</delta> today')).toBe('<delta> {{change}} {{percent}}');
    expect(slots('plain words')).toBe('');
  });
});

describe('the English catalogue', () => {
  const flat = flatten(english);

  it('is what the screen shows: no key is blank', () => {
    expect([...flat].filter(([, text]) => text.trim() === '')).toEqual([]);
  });

  it('keeps `count` for numbers, where i18next uses it to choose a plural form', () => {
    // A formatted figure ("5,223") under `count` would pick a plural form by
    // parsing text; such strings name their placeholder `value` instead.
    expect(t('holdings.title', { count: 3 })).toBe('Holdings (3)');
    expect(t('digest.findings', { count: 1 })).toBe('1 finding');
    expect(t('digest.findings', { count: 2 })).toBe('2 findings');
  });

  it('does not escape what React will escape anyway', () => {
    expect(t('import.candidate', { symbol: 'T', name: 'AT&T Inc.' })).toBe('T — AT&T Inc.');
  });

  it('is the language the app starts in', () => {
    expect(i18n.language).toBe(DEFAULT_LANGUAGE);
  });
});

describe('figures are formatted by the language, and English reads as it always did', () => {
  it('signs a change, including a zero, and never hand-builds the sign', () => {
    expect(formatPercent(0.41)).toBe('+0.41%');
    expect(formatPercent(-1.38)).toBe('-1.38%');
    expect(formatPercent(0)).toBe('+0.00%');
    expect(formatPercent(-0)).toBe('+0.00%');
    expect(formatPercent(null)).toBe('—');
  });

  it('leaves a share unsigned', () => {
    expect(formatShare(35.4)).toBe('35.4%');
    expect(formatShare(8.19, 2)).toBe('8.19%');
    expect(formatShare(null)).toBe('—');
  });

  it('formats money in its own currency, and an unknown price as unknown', () => {
    expect(formatMoney(10_046_956, 'USD')).toBe('$100,469.56');
    expect(formatMoney(18674, 'EUR')).toBe('€186.74');
    expect(formatMoney(null, 'USD')).toBe('—');
  });

  it('groups counts', () => {
    expect(formatNumber(16_363)).toBe('16,363');
  });
});

/**
 * Text written straight into a component is text a translation cannot reach.
 * The ones listed are deliberate: a ticker used as an example, and questions
 * that become the question sent to an English service (`AskPage.tsx`).
 */
const ALLOWED_LITERALS = new Set(['AAPL']);
const UI_ATTRIBUTES = new Set(['aria-label', 'title', 'placeholder', 'alt', 'label', 'hint', 'body']);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.tsx') ? [path] : [];
  });
}

describe('no interface text is written into a component', () => {
  it('finds no words in JSX text or in a text attribute', () => {
    const src = resolve(import.meta.dirname, '../src');
    const found: string[] = [];
    for (const file of sourceFiles(src)) {
      const tree = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const where = (node: ts.Node) =>
        `${file.slice(src.length + 1)}:${tree.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
      const visit = (node: ts.Node): void => {
        if (ts.isJsxText(node) && /\p{L}{2,}/u.test(node.text)) {
          found.push(`${where(node)} ${node.text.trim()}`);
        }
        if (ts.isJsxAttribute(node) && UI_ATTRIBUTES.has(node.name.getText()) && node.initializer) {
          const value = node.initializer;
          if (ts.isStringLiteral(value) && /\p{L}{2,}/u.test(value.text) && !ALLOWED_LITERALS.has(value.text)) {
            found.push(`${where(node)} ${node.getText()}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(tree);
    }
    expect(found).toEqual([]);
  });
});
