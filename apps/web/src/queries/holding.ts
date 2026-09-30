/**
 * One holding's page: its stored closes, its week of news, its findings.
 *
 * The position figures are not here - they are the cached portfolio, read by
 * `usePortfolioQuery`, so the page and the dashboard can never disagree about
 * a holding's value.
 */

import { queryOptions, useQuery } from '@tanstack/react-query';

import type { HoldingHistoryResponse, HoldingNewsResponse, ObservationsResponse } from '@traders/shared';

import { api } from '../api/client.ts';
import { OBSERVATIONS_PAGE_SIZE } from './observations.ts';
import { queryKeys } from './queryKeys.ts';

export function holdingHistoryQuery(holdingId: string) {
  return queryOptions({
    queryKey: queryKeys.holdingHistory(holdingId),
    queryFn: () => api.get<HoldingHistoryResponse>(`/holdings/${holdingId}/history`),
    // Closes are added once a day; a re-read every 30 s would only repeat them.
    staleTime: 5 * 60_000,
  });
}

export function holdingNewsQuery(holdingId: string) {
  return queryOptions({
    queryKey: queryKeys.holdingNews(holdingId),
    queryFn: () => api.get<HoldingNewsResponse>(`/holdings/${holdingId}/news`),
  });
}

export function symbolObservationsQuery(symbol: string) {
  return queryOptions({
    queryKey: queryKeys.symbolObservations(symbol),
    queryFn: async () =>
      (
        await api.get<ObservationsResponse>(
          `/observations?limit=${OBSERVATIONS_PAGE_SIZE}&symbol=${encodeURIComponent(symbol)}`,
        )
      ).observations ?? [],
  });
}

/** `enabled` is false until the holding is known to exist, so a stale link asks nothing. */
export function useHoldingHistoryQuery(holdingId: string, enabled: boolean) {
  return useQuery({ ...holdingHistoryQuery(holdingId), enabled });
}

export function useHoldingNewsQuery(holdingId: string, enabled: boolean) {
  return useQuery({ ...holdingNewsQuery(holdingId), enabled });
}

export function useSymbolObservationsQuery(symbol: string | null) {
  return useQuery({ ...symbolObservationsQuery(symbol ?? ''), enabled: symbol !== null });
}
