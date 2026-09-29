/** The observations feed: the newest page of findings. */

import { queryOptions, useQuery } from '@tanstack/react-query';

import type { ObservationsResponse } from '@traders/shared';

import { api } from '../api/client.ts';
import { queryKeys } from './queryKeys.ts';

/** One page is a feed, not an archive; the engine emits few findings per run. */
export const OBSERVATIONS_PAGE_SIZE = 50;

export const observationsQuery = queryOptions({
  queryKey: queryKeys.observations,
  // The API already returns newest first; trusting it keeps one ordering rule
  // in the system rather than two that can disagree.
  queryFn: async () =>
    (await api.get<ObservationsResponse>(`/observations?limit=${OBSERVATIONS_PAGE_SIZE}`))
      .observations ?? [],
});

export function useObservationsQuery() {
  return useQuery(observationsQuery);
}
