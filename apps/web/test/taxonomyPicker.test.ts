/**
 * The sector picker's matching: what a typed query lists, and in what order.
 */

import { describe, expect, it } from 'vitest';

import type { UniverseTaxonomyResponse } from '@traders/shared';

import { matchingChoices, taxonomyChoices } from '../src/components/TaxonomyPicker.tsx';

const TAXONOMY: UniverseTaxonomyResponse = {
  sectors: [
    { name: 'Healthcare', instruments: 300, industries: [{ name: 'Biotechnology', instruments: 120 }], etfCategories: [] },
    {
      name: 'Technology',
      instruments: 488,
      industries: [
        { name: 'Semiconductors', instruments: 38 },
        { name: 'Technology Distributors', instruments: 6 },
      ],
      etfCategories: [{ name: 'Technology', instruments: 20 }],
    },
  ],
  etfCategories: [{ name: 'Digital Assets', instruments: 33 }],
  updatedAt: '2026-10-18T00:00:00Z',
};

const choices = taxonomyChoices(TAXONOMY);
const listed = (query: string) => matchingChoices(choices, query).map((choice) => `${choice.kind}:${choice.name}`);

describe('matching a typed query', () => {
  it('ranks the exact name, then a prefix, then a substring, then a match on the sector alone', () => {
    expect(listed('tech')).toEqual([
      'sector:Technology',
      'industry:Technology Distributors',
      'etf_category:Technology',
      'industry:Biotechnology',
      'industry:Semiconductors',
    ]);
  });

  it('puts a sector before an industry or category of the same name and rank', () => {
    expect(listed(' Technology ').slice(0, 2)).toEqual(['sector:Technology', 'etf_category:Technology']);
  });

  it('keeps the grouped order when nothing is typed', () => {
    expect(matchingChoices(choices, '  ')).toBe(choices);
  });
});
