/**
 * Whether the explanations in the feed were written by a model.
 *
 * Read when the dashboard opens and on focus, never polled: the state changes
 * when a scan runs, every thirty minutes at most. A failure is not retried and
 * not reported - the badge simply renders nothing. It is an indicator *about*
 * reliability, and one that reported its own outage as a product fault would
 * be the most misleading thing on the page.
 */

import { queryOptions, useQuery } from '@tanstack/react-query';

import type { NarrationHealthResponse } from '@traders/shared';

import { api } from '../api/client.ts';
import { queryKeys } from './queryKeys.ts';

export const narrationQuery = queryOptions({
  queryKey: queryKeys.narration,
  queryFn: () => api.get<NarrationHealthResponse>('/narration'),
  retry: false,
});

export function useNarrationQuery() {
  return useQuery(narrationQuery);
}
