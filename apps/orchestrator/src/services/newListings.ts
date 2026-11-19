/**
 * The daily new-listings screen (migration 0088): listings that pass the
 * universe's rule between rescreens are admitted as `listed` members, so a
 * company that has just gone public is found by a topic and tradable from the
 * next scan instead of at the next quarterly rescreen.
 *
 * The installation's work, under no user (D238), on a daily key in the
 * installation's timezone. Its first ask of the day comes after the US close
 * for the default `Asia/Jerusalem`, which is when Yahoo's sizes are the day's.
 * The AI service answers when it is done - the screen alone and at most a
 * run's cap of profiles - so this records the answer rather than handing over
 * like the rescreen.
 *
 * How the run ends:
 * - `ok`: the screen ran. A listing Yahoo has not described yet is not a
 *   failure - it is asked about again tomorrow - so it does not degrade the run.
 * - `degraded`: the source could not be asked for some listing, or one was
 *   admitted without an embedding (tradable, but no topic finds it until the
 *   next load embeds it).
 * - `skipped`: the installation has no profile source - a configuration.
 * A screen that could not be fetched throws, the run is `failed`, and the next
 * hourly ask claims it again (`RETRY_FAILED_KINDS`).
 */

import type { AiClient, NewListingsResponse } from '@traders/shared/ai';

export const NEW_LISTINGS_KIND = 'new_listings';

export interface NewListingsOutcome {
  status: 'ok' | 'degraded' | 'skipped';
  result: Record<string, unknown>;
}

export function newListingsOutcome(answer: NewListingsResponse): NewListingsOutcome {
  if (answer.status === 'unavailable') {
    return { status: 'skipped', result: { reason: answer.reason ?? 'this installation cannot screen' } };
  }
  const failed = answer.failed ?? [];
  const unembedded = answer.unembedded ?? [];
  const result = {
    screened: answer.screened,
    kept: answer.kept,
    candidates: answer.candidates,
    sameCompany: answer.same_company,
    deferred: answer.deferred,
    admitted: answer.admitted ?? [],
    noListing: answer.no_listing ?? [],
    outsideScreen: answer.outside_screen ?? [],
    noDescription: answer.no_description ?? [],
    noCurrency: answer.no_currency ?? [],
    failed,
    unembedded,
  };
  return { status: failed.length > 0 || unembedded.length > 0 ? 'degraded' : 'ok', result };
}

export async function runNewListings(
  ai: Pick<AiClient, 'newListings'>,
  requestId?: string,
): Promise<NewListingsOutcome> {
  return newListingsOutcome(await ai.newListings(requestId));
}
