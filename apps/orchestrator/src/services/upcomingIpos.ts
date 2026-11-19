/**
 * The daily upcoming-IPO run (migration 0089, D404-D408): companies on their
 * way to an IPO, read from SEC EDGAR - dates and stages only - so a company is
 * known before it trades, not only once the new-listings screen admits it.
 *
 * The installation's work, under no user (D238), on a daily key in the
 * installation's timezone. The AI service answers when it is done (two
 * searches and at most a run's cap of company histories), so this records the
 * answer, like the new-listings screen.
 *
 * How the run ends:
 * - `ok`: the searches ran. Registrants left for tomorrow by the cap are not a
 *   failure: the next run still sees them inside its lookback.
 * - `degraded`: some company's history could not be fetched; the next run asks
 *   for it again.
 * - `skipped`: FILINGS_PROVIDER is off - a configuration.
 * A search that failed throws, the run is `failed`, and the next hourly ask
 * claims it again (`RETRY_FAILED_KINDS`).
 */

import type { AiClient, UpcomingIposResponse } from '@traders/shared/ai';

export const UPCOMING_IPOS_KIND = 'upcoming_ipos';

export interface UpcomingIposOutcome {
  status: 'ok' | 'degraded' | 'skipped';
  result: Record<string, unknown>;
}

export function upcomingIposOutcome(answer: UpcomingIposResponse): UpcomingIposOutcome {
  if (answer.status === 'unavailable') {
    return { status: 'skipped', result: { reason: answer.reason ?? 'this installation reads no filings' } };
  }
  const failed = answer.failed ?? [];
  const result = {
    searched: answer.searched,
    tracked: answer.tracked ?? [],
    excluded: answer.excluded ?? {},
    advanced: answer.advanced ?? [],
    listed: answer.listed ?? [],
    failed,
    deferred: answer.deferred,
  };
  return { status: failed.length > 0 ? 'degraded' : 'ok', result };
}

export async function runUpcomingIpos(
  ai: Pick<AiClient, 'upcomingIpos'>,
  requestId?: string,
): Promise<UpcomingIposOutcome> {
  return upcomingIposOutcome(await ai.upcomingIpos(requestId));
}
