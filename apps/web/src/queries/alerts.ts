/**
 * The Alerts tab (decision 134): what the user was told, a page at a time,
 * optionally from one source - the main portfolio, topics, or the agents.
 */

import { infiniteQueryOptions, useInfiniteQuery } from '@tanstack/react-query';

import type { Alert, AlertSource, AlertsResponse } from '@traders/shared';

import { api } from '../api/client.ts';
import { FEED_PAGE_SIZE } from './observations.ts';
import { queryKeys } from './queryKeys.ts';

function alertsPath(source: AlertSource | undefined, before: string | null): string {
  const params = new URLSearchParams({ limit: String(FEED_PAGE_SIZE) });
  if (source) params.set('source', source);
  if (before) params.set('before', before);
  return `/notifications/alerts?${params.toString()}`;
}

export function alertsQuery(source: AlertSource | undefined) {
  return infiniteQueryOptions({
    queryKey: queryKeys.alerts(source ?? null),
    queryFn: ({ pageParam }) => api.get<AlertsResponse>(alertsPath(source, pageParam)),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function useAlertsQuery(source: AlertSource | undefined) {
  return useInfiniteQuery(alertsQuery(source));
}

/** Every alert loaded so far, in the order the server sent them. */
export function loadedAlerts(pages: AlertsResponse[] | undefined): Alert[] {
  return (pages ?? []).flatMap((page) => page.alerts ?? []);
}
