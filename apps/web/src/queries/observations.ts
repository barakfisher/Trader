/**
 * The observations feed: findings a page at a time, optionally filtered.
 *
 * A page rather than everything: 50 findings made the feed 8,000 px of a
 * 9,500 px dashboard (measured 2026-09-30), and the newest few are what a
 * reader opens the page for. The rest are one press away, never gone.
 */

import { infiniteQueryOptions, useInfiniteQuery } from '@tanstack/react-query';

import type { Observation, ObservationSeverity, ObservationsResponse } from '@traders/shared';

import { api } from '../api/client.ts';
import { queryKeys } from './queryKeys.ts';

/** The most a holding page asks for in one read (`queries/holding.ts`). */
export const OBSERVATIONS_PAGE_SIZE = 50;

/** One page of the dashboard's feed, and what "Show more" adds. */
export const FEED_PAGE_SIZE = 10;

export interface FeedFilters {
  /** At least this severe; undefined is every severity. */
  severity?: Exclude<ObservationSeverity, 'info'>;
  /** Findings about one symbol; undefined is every subject. */
  symbol?: string;
}

function feedPath(filters: FeedFilters, before: string | null): string {
  const params = new URLSearchParams({ limit: String(FEED_PAGE_SIZE) });
  if (filters.severity) params.set('severity', filters.severity);
  if (filters.symbol) params.set('symbol', filters.symbol);
  if (before) params.set('before', before);
  return `/observations?${params.toString()}`;
}

export function feedQuery(filters: FeedFilters) {
  return infiniteQueryOptions({
    // Keyed by the filters, under the feed's prefix, so anything that refreshes
    // the feed refreshes every filtered view of it too.
    queryKey: queryKeys.feed(filters.severity ?? null, filters.symbol ?? null),
    queryFn: ({ pageParam }) => api.get<ObservationsResponse>(feedPath(filters, pageParam)),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function useFeedQuery(filters: FeedFilters) {
  return useInfiniteQuery(feedQuery(filters));
}

/** Every finding loaded so far, in the order the server sent them. */
export function loadedFindings(pages: ObservationsResponse[] | undefined): Observation[] {
  return (pages ?? []).flatMap((page) => page.observations ?? []);
}
