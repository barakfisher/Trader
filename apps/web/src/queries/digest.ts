/** The daily digest as the dashboard shows it: the next one, and the last one delivered. */

import { queryOptions, useQuery } from '@tanstack/react-query';

import type { DigestResponse } from '@traders/shared';

import { api } from '../api/client.ts';
import { queryKeys } from './queryKeys.ts';

export const digestQuery = queryOptions({
  queryKey: queryKeys.digest,
  queryFn: () => api.get<DigestResponse>('/notifications/digest'),
});

export function useDigestQuery() {
  return useQuery(digestQuery);
}
