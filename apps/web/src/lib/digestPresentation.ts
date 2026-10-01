/**
 * The digest in words. The reasons are the ones the Telegram digest itself
 * prints (`summariseDigest` in the orchestrator), so the two surfaces describe
 * a held-back finding the same way.
 */

import type { DigestEntry, DigestReason } from '@traders/shared';

import { t } from '../i18n/index.ts';

const REASONS: readonly DigestReason[] = ['below_floor', 'quiet_hours', 'muted', 'above_floor'];

export function reasonText(reason: string): string {
  return REASONS.includes(reason as DigestReason) ? t(`digest.reasons.${reason as DigestReason}`) : reason;
}

/** "2 held during quiet hours, 1 below your alert threshold" - one clause per reason. */
export function reasonSummary(entries: DigestEntry[]): string {
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1);
  return [...counts.entries()]
    .map(([reason, count]) => t('digest.reasonClause', { count, reason: reasonText(reason) }))
    .join(t('common.listSeparator'));
}

/** Findings only: a narration notice rides in the digest but is not a finding. */
export function findingsIn(entries: DigestEntry[]): DigestEntry[] {
  return entries.filter((entry) => entry.observationId !== null);
}

export function countText(count: number): string {
  return t('digest.findings', { count });
}
