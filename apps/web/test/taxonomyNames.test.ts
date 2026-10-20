/**
 * Yahoo's taxonomy names in the interface's language (D190-D193).
 *
 * The map is held to the committed universe snapshot both ways, as `parity.ts`
 * holds a catalogue to English: every name the universe holds has a
 * translation, and no translation names something the universe does not hold.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { applyLanguage, DEFAULT_LANGUAGE, LANGUAGES } from '../src/i18n/index.ts';
import { TAXONOMY_NAMES, taxonomyLabel, taxonomyPhrase } from '../src/i18n/taxonomyNames.ts';
import { EMPTY_MANDATE_DRAFT, describeMandate } from '../src/lib/agentMandate.ts';
import { matchingChoices, taxonomyChoices } from '../src/components/TaxonomyPicker.tsx';

const SNAPSHOT = resolve(__dirname, '../../../data/universe/instruments.jsonl');

function committedNames(): Set<string> {
  const names = new Set<string>();
  for (const line of readFileSync(SNAPSHOT, 'utf-8').split('\n')) {
    if (line.trim() === '') continue;
    const row = JSON.parse(line) as { sector?: string | null; industry?: string | null; category?: string | null };
    for (const name of [row.sector, row.industry, row.category]) if (name) names.add(name);
  }
  return names;
}

afterEach(() => applyLanguage(DEFAULT_LANGUAGE, null));

describe('every language names what the universe holds', () => {
  const committed = committedNames();
  const translated = LANGUAGES.filter((language) => language !== DEFAULT_LANGUAGE);

  it.each(translated)('%s translates every committed sector, industry and ETF category', (language) => {
    const names = TAXONOMY_NAMES[language] ?? {};
    expect([...committed].filter((name) => !(name in names)).sort()).toEqual([]);
  });

  it.each(translated)('%s translates nothing the universe does not hold', (language) => {
    expect(Object.keys(TAXONOMY_NAMES[language] ?? {}).filter((name) => !committed.has(name))).toEqual([]);
  });

  it.each(translated)('%s gives no two names the same translation', (language) => {
    const texts = Object.values(TAXONOMY_NAMES[language] ?? {});
    const repeated = texts.filter((text, index) => texts.indexOf(text) !== index);
    // "Health" (an ETF category) and "Healthcare" (a sector) are one word in Hebrew,
    // and a chip says which kind it is.
    expect(repeated).toEqual(language === 'he' ? ['בריאות'] : []);
  });
});

describe('a name as the interface shows it', () => {
  it('is the English name, marked English, in English', () => {
    expect(taxonomyLabel('Technology', 'en')).toEqual({ text: 'Technology', lang: 'en' });
  });

  it('is translated in Hebrew', () => {
    expect(taxonomyLabel('Technology', 'he')).toEqual({ text: 'טכנולוגיה', lang: undefined });
  });

  it('falls back to English, marked English, for a name Yahoo added after the snapshot', () => {
    expect(taxonomyLabel('Quantum Computing', 'he')).toEqual({ text: 'Quantum Computing', lang: 'en' });
    expect(taxonomyPhrase('Quantum Computing', 'he')).toBe('Quantum Computing');
  });

  it('keeps the English identifier beside the translation in instructions', () => {
    expect(taxonomyPhrase('Technology', 'he')).toBe('טכנולוגיה (Technology)');
    expect(taxonomyPhrase('Technology', 'en')).toBe('Technology');
  });
});

describe('Hebrew in the picker and the instructions', () => {
  const choices = taxonomyChoices({
    sectors: [
      {
        name: 'Technology',
        instruments: 488,
        industries: [{ name: 'Semiconductors', instruments: 38 }],
        etfCategories: [],
      },
    ],
    etfCategories: [],
    updatedAt: '2026-10-19T00:00:00Z',
  });
  const listed = (query: string) => matchingChoices(choices, query, 'he').map((choice) => choice.name);

  it('finds a name by its translation and by its English name', () => {
    expect(listed('שבבים')).toEqual(['Semiconductors']);
    expect(listed('semi')).toEqual(['Semiconductors']);
  });

  it('finds an industry by its sector in Hebrew', () => {
    expect(listed('טכנולוגיה')).toEqual(['Technology', 'Semiconductors']);
  });

  it('writes the focus sentence with Hebrew names and the English in brackets', () => {
    applyLanguage('he', null);
    const text = describeMandate({ ...EMPTY_MANDATE_DRAFT, sectors: ['Technology'], industries: ['Semiconductors'] });
    expect(text).toContain('טכנולוגיה (Technology)');
    expect(text).toContain('שבבים (Semiconductors)');
  });

  it('stores the English names whatever the language', () => {
    applyLanguage('he', null);
    expect(matchingChoices(choices, 'שבבים').map((choice) => choice.kind + ':' + choice.name)).toEqual([
      'industry:Semiconductors',
    ]);
  });
});
