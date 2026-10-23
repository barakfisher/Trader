/**
 * Whether the signed-in user's model work can run right now (D245, D250, D280).
 *
 * The admin runs on the installation's key; everyone else on their own
 * OpenRouter key only, under their optional monthly safety limit. This reads the
 * two Settings reads the key card already makes - the month (null for the admin)
 * and the key - and says what stops the user, so Ask, the Agents page and a
 * re-check can say it up front and keep their buttons from promising a call that
 * would be refused. The server refuses regardless; this is never the gate.
 *
 * Nothing is claimed while either read is pending or failed: a notice that is
 * wrong is worse than the server's refusal arriving after a click.
 */

import type { MonthlySpend, OwnLlmKeyResponse } from '@traders/shared';

import { useMonthlySpendQuery, useOwnLlmKeyQuery } from './settings.ts';

/** What stops the user's model calls, or null when nothing does (or nothing is known). */
export type ModelBlock = 'no_key' | 'key_failed' | 'unavailable' | 'safety_limit';

export interface ModelAccess {
  block: ModelBlock | null;
  /** `YYYY-MM-DD`, the local day the safety limit's month starts again. */
  resetsOn: string | null;
}

export function useModelAccess(): ModelAccess {
  const spend = useMonthlySpendQuery().data;
  const ownKey = useOwnLlmKeyQuery(Boolean(spend)).data;
  if (!spend || !ownKey) return { block: null, resetsOn: null };
  return { block: blockOf(spend, ownKey), resetsOn: spend.resetsOn };
}

export function blockOf(spend: MonthlySpend, ownKey: OwnLlmKeyResponse): ModelBlock | null {
  if (!ownKey.available) return 'unavailable';
  if (ownKey.key === null) return 'no_key';
  if (ownKey.key.status === 'failed') return 'key_failed';
  if (spend.safetyLimitMicroUsd !== null && spend.ownKeySpentMicroUsd >= spend.safetyLimitMicroUsd) {
    return 'safety_limit';
  }
  return null;
}
