/**
 * How a universe gap reads on the admin page. Kept apart from the component
 * so the wording - which is the whole point of the card - can be tested.
 */

import type { UniverseGap } from '@traders/shared';

import { formatFixed } from '../i18n/format.ts';
import { i18n, t } from '../i18n/index.ts';

function rule(name: string): string {
  return i18n.exists(`gaps.rules.${name}`) ? t(`gaps.rules.${name as 'exchange'}`) : t('gaps.outsideScreen');
}

function source(name: string): string {
  return i18n.exists(`gaps.sources.${name}`) ? t(`gaps.sources.${name as 'import'}`) : t('gaps.named');
}

/** The headline: what was asked for. */
export function gapSubject(gap: UniverseGap): string {
  const detail = gap.detail;
  if (gap.kind === 'universe_gap_low_confidence') return t('gaps.quoted', { text: String(detail.topic ?? '') });
  return String(detail.symbol ?? '');
}

/** Why it is a gap, in words - and whether it is one a rescreen could close. */
export function gapExplanation(gap: UniverseGap): string {
  const detail = gap.detail;
  if (gap.kind === 'universe_gap_low_confidence') {
    const score = (value: unknown) =>
      typeof value === 'number' ? formatFixed(value, 2) : t('common.notAvailable');
    return t('gaps.lowConfidence', { best: score(detail.bestSimilarity), gate: score(detail.refuseBelow) });
  }
  const where = source(String(detail.source));
  switch (detail.gap) {
    case 'outside_screen':
      return t('gaps.because', { where, why: rule(String(detail.rule)) });
    case 'not_in_universe':
      return t('gaps.because', { where, why: t('gaps.notInUniverse') });
    case 'unpriced':
      return t('gaps.because', { where, why: t('gaps.unpriced') });
    default:
      return where;
  }
}

/**
 * Only a gap a rescreen could close deserves the eye; the rest are expected,
 * and one a rescreen has already closed is history.
 */
export function isRealGap(gap: UniverseGap): boolean {
  if (gap.profile === 'screened') return false;
  return gap.kind === 'universe_gap_low_confidence' || gap.detail.gap === 'not_in_universe';
}

/**
 * What has become of a missing ticker's listing since, or null when nothing
 * has. An on-demand profile describes it without making it a member, so the
 * gap stays open - and the card says why.
 */
export function gapProfile(gap: UniverseGap): string | null {
  switch (gap.profile) {
    case 'on_demand':
    case 'screened':
    case 'dropped':
      return t(`gaps.profiles.${gap.profile}`);
    default:
      return null;
  }
}
