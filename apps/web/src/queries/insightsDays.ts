/**
 * The Insights window (decision 133): seven local days, today first, with how
 * many of the main portfolio's findings each holds and how many are unread -
 * the bar's dot, the All findings tab's count and the day stepper all read it.
 */

import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { InsightsDaysResponse } from '@traders/shared';

import { api } from '../api/client.ts';
import { queryKeys } from './queryKeys.ts';

export const insightsDaysQuery = queryOptions({
  queryKey: queryKeys.insightsDays,
  queryFn: () => api.get<InsightsDaysResponse>('/observations/days'),
});

export function useInsightsDaysQuery(options: { enabled?: boolean } = {}) {
  return useQuery({ ...insightsDaysQuery, enabled: options.enabled ?? true });
}

/** Unread findings across the window; zero until the counts arrive. */
export function unreadCount(days: InsightsDaysResponse | undefined): number {
  return (days?.days ?? []).reduce((sum, day) => sum + day.unread, 0);
}

/**
 * Mark the findings counted at `upTo` as seen (the user, 2026-10-11: opening
 * All findings or Alerts). The dot goes at once; the server's answer then
 * replaces the guess, and a failed write brings the dot back on the next read,
 * which is the honest outcome - it was not recorded.
 */
export function useMarkInsightsSeen() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (upTo: string) =>
      api.post<{ seenAt: string | null }>('/observations/seen', { upTo }),
    onMutate: (upTo) =>
      client.setQueryData<InsightsDaysResponse>(queryKeys.insightsDays, (current) =>
        current
          ? {
              ...current,
              seenAt: upTo,
              days: current.days.map((day) => ({ ...day, unread: 0 })),
            }
          : current,
      ),
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.insightsDays }),
  });
}
