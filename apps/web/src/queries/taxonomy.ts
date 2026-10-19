/**
 * The universe's sector/industry taxonomy, for the "Sectors & industries"
 * picker (D164). It changes only when the universe is reloaded, so an hour's
 * staleness costs nothing and opening the form twice asks once.
 */

import { useQuery } from '@tanstack/react-query';

import type { UniverseTaxonomyResponse } from '@traders/shared';

import { api } from '../api/client.ts';
import { queryKeys } from './queryKeys.ts';

const HOUR_MS = 60 * 60 * 1000;

export function useTaxonomyQuery() {
  return useQuery({
    queryKey: queryKeys.taxonomy,
    queryFn: () => api.get<UniverseTaxonomyResponse>('/universe/taxonomy'),
    staleTime: HOUR_MS,
  });
}
