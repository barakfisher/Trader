/**
 * Agents (multi-agent Stage 2): the list, one agent, and the two writes.
 *
 * Writes invalidate the list prefix rather than patching the cache, as the
 * portfolio's do: the server owns every rule about an agent (the budget's
 * cents, the primary being unchangeable), so the cache shows what it stored.
 */

import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { AgentInput, AgentPatchInput, AgentView, AgentsResponse } from '@traders/shared';

import { api } from '../api/client.ts';
import { queryKeys } from './queryKeys.ts';

export const agentsQuery = queryOptions({
  queryKey: queryKeys.agents,
  queryFn: async () => (await api.get<AgentsResponse>('/agents')).agents,
});

export function useAgentsQuery() {
  return useQuery(agentsQuery);
}

export function useAgentQuery(agentId: string) {
  return useQuery({
    queryKey: queryKeys.agent(agentId),
    queryFn: () => api.get<AgentView>(`/agents/${agentId}`),
  });
}

function useInvalidateAgents() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: queryKeys.agents });
}

export function useCreateAgent() {
  const invalidate = useInvalidateAgents();
  return useMutation({
    mutationFn: (input: AgentInput) => api.post<AgentView>('/agents', input),
    onSuccess: invalidate,
  });
}

export function useUpdateAgent(agentId: string) {
  const invalidate = useInvalidateAgents();
  return useMutation({
    mutationFn: (patch: AgentPatchInput) => api.patch<AgentView>(`/agents/${agentId}`, patch),
    onSuccess: invalidate,
  });
}
