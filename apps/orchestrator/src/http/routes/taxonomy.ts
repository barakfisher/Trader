/**
 * The universe's sector/industry taxonomy, for the agent creator's "Sectors &
 * industries" picker (D164).
 *
 * Read from `universe_taxonomy`, which the universe loader rewrites; nothing
 * here reaches Yahoo, so the picker can ask on every open. Grouped here rather
 * than in the browser so that the shape the picker renders - sector, then its
 * industries and ETF categories, then the categories with no sector - is
 * decided once, next to the query that guarantees it.
 */

import type { Hono } from 'hono';

import type { TaxonomyEntry, TaxonomySector, UniverseTaxonomyResponse } from '@traders/shared';

import { listTaxonomy, type TaxonomyRow } from '../../db/queries.js';
import { currentUserId, type AppEnv } from '../app.js';

const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name, 'en');

export function groupTaxonomy(rows: TaxonomyRow[]): UniverseTaxonomyResponse {
  const sectors = new Map<string, TaxonomySector>();
  const sectorless: TaxonomyEntry[] = [];
  let updatedAt: Date | null = null;
  for (const row of rows) {
    if (updatedAt === null || row.updated_at > updatedAt) updatedAt = row.updated_at;
    const entry = { name: row.name, instruments: row.instruments };
    if (row.sector === null) {
      sectorless.push(entry);
      continue;
    }
    const sector = sectors.get(row.sector) ?? {
      name: row.sector,
      instruments: 0,
      industries: [],
      etfCategories: [],
    };
    sector.instruments += row.instruments;
    (row.kind === 'industry' ? sector.industries : sector.etfCategories).push(entry);
    sectors.set(row.sector, sector);
  }
  for (const sector of sectors.values()) {
    sector.industries.sort(byName);
    sector.etfCategories.sort(byName);
  }
  return {
    sectors: [...sectors.values()].sort(byName),
    etfCategories: sectorless.sort(byName),
    updatedAt: updatedAt?.toISOString() ?? null,
  };
}

export function registerTaxonomyRoutes(app: Hono<AppEnv>): void {
  app.get('/universe/taxonomy', async (context) => {
    currentUserId(context);
    return context.json(groupTaxonomy(await listTaxonomy()));
  });
}
