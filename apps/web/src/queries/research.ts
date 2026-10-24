/**
 * Research on the main portfolio (D254, D289-D293): the assigned agent, its
 * latest run and each holding's latest rating - one read for the research page
 * and the Dashboard's *Sentiment* column, so the two never disagree.
 *
 * While a run is going the read is repeated every `RESEARCH_POLL_MS`: the run
 * rates one holding at a time in the background, and the page shows each
 * rating as it lands. Nothing polls once it has finished.
 */

import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { ResearchAgentInput, ResearchResponse } from '@traders/shared';

import { api } from '../api/client.ts';
import { queryKeys } from './queryKeys.ts';

/** How often a running research is read again. */
export const RESEARCH_POLL_MS = 5_000;

export const researchQuery = queryOptions({
  queryKey: queryKeys.research,
  queryFn: () => api.get<ResearchResponse>('/research'),
  refetchInterval: (query) => (query.state.data?.run?.status === 'running' ? RESEARCH_POLL_MS : false),
});

export function useResearchQuery() {
  return useQuery(researchQuery);
}

export function useAssignResearchAgent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (agentId: string | null) =>
      api.put<ResearchResponse>('/research/agent', { agentId } satisfies ResearchAgentInput),
    onSuccess: (body) => client.setQueryData(queryKeys.research, body),
  });
}

export function useStartResearch() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ run_id: string; holdings: number }>('/research/runs', {}),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.research }),
  });
}
