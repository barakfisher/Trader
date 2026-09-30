/**
 * How a universe gap reads on the admin page. Kept apart from the component
 * so the wording - which is the whole point of the card - can be tested.
 */

import type { UniverseGap } from '@traders/shared';

const RULES: Record<string, string> = {
  asset_class: 'not an equity or ETF, so never screened',
  exchange: 'not listed on a primary US exchange, so never screened',
};

const SOURCES: Record<string, string> = {
  holding: 'added as a holding',
  import: 'in an import',
  topic: 'added to a topic',
};

/** The headline: what was asked for. */
export function gapSubject(gap: UniverseGap): string {
  const detail = gap.detail;
  if (gap.kind === 'universe_gap_low_confidence') return `“${String(detail.topic ?? '')}”`;
  return String(detail.symbol ?? '');
}

/** Why it is a gap, in words - and whether it is one a rescreen could close. */
export function gapExplanation(gap: UniverseGap): string {
  const detail = gap.detail;
  if (gap.kind === 'universe_gap_low_confidence') {
    const best = typeof detail.bestSimilarity === 'number' ? detail.bestSimilarity.toFixed(2) : 'n/a';
    const gate = typeof detail.refuseBelow === 'number' ? detail.refuseBelow.toFixed(2) : 'n/a';
    return `topic matched nothing: best score ${best}, gate ${gate}`;
  }
  const where = SOURCES[String(detail.source)] ?? 'named';
  switch (detail.gap) {
    case 'outside_screen':
      return `${where}; ${RULES[String(detail.rule)] ?? 'outside the screen'}`;
    case 'not_in_universe':
      return `${where}; a US listing the universe lacks - below the size floor or listed since the snapshot`;
    case 'unpriced':
      return `${where}; no market data provider could price it`;
    default:
      return where;
  }
}

/** Only a gap a rescreen could close deserves the eye; the rest are expected. */
export function isRealGap(gap: UniverseGap): boolean {
  return gap.kind === 'universe_gap_low_confidence' || gap.detail.gap === 'not_in_universe';
}
