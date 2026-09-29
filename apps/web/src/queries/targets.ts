/** The allocation targets the user has stated, as the server stores them. */

import { queryOptions, useQuery } from '@tanstack/react-query';

import type { TargetsResponse } from '@traders/shared';

import { api } from '../api/client.ts';
import { queryKeys } from './queryKeys.ts';

export const targetsQuery = queryOptions({
  queryKey: queryKeys.targets,
  queryFn: async () => (await api.get<TargetsResponse>('/targets')).targets,
});

export function useTargetsQuery() {
  return useQuery(targetsQuery);
}
