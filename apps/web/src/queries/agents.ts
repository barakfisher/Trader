/**
 * Agents (multi-agent Stage 2): the list, one agent, and the two writes.
 *
 * Writes invalidate the list prefix rather than patching the cache, as the
 * portfolio's do: the server owns every rule about an agent (the budget's
 * cents, the primary being unchangeable), so the cache shows what it stored.
 */

import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  ActivityResponse,
  AgentAccountResponse,
  AgentInput,
  AgentPatchInput,
  AgentView,
  AgentsResponse,
  TopUpInput,
  TradeInput,
  TradePreview,
  TradeResult,
} from '@traders/shared';

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
  // The consolidated view lives under the portfolio's key, not the agents':
  // a trade, a top-up or a pause changes what it shows as well.
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.agents }),
      client.invalidateQueries({ queryKey: queryKeys.consolidated }),
    ]);
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

/** A simulated agent's cash, holdings and standing (Stage 3). Not asked of the primary. */
export function useAgentAccountQuery(agentId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.agentAccount(agentId),
    queryFn: () => api.get<AgentAccountResponse>(`/agents/${agentId}/account`),
    enabled,
  });
}

/** Every movement of the agent's cash, newest first, with the balance after each (D31). */
export function useAgentActivityQuery(agentId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.agentActivity(agentId),
    queryFn: () => api.get<ActivityResponse>(`/agents/${agentId}/activity`),
    enabled,
  });
}

/** What a trade would do. A mutation, not a query: it is asked for, and never cached. */
export function usePreviewTrade(agentId: string) {
  return useMutation({
    mutationFn: (input: TradeInput) => api.post<TradePreview>(`/agents/${agentId}/trades/preview`, input),
  });
}

/** Record a trade. Cash, holdings and the timeline all live under the agent's key. */
export function useTrade(agentId: string) {
  const invalidate = useInvalidateAgents();
  return useMutation({
    mutationFn: (input: TradeInput) => api.post<TradeResult>(`/agents/${agentId}/trades`, input),
    onSuccess: invalidate,
  });
}

/** Add cash: the server raises the budget by the amount, in one statement (D22, D31). */
export function useTopUp(agentId: string) {
  const invalidate = useInvalidateAgents();
  return useMutation({
    mutationFn: (input: TopUpInput) => api.post<AgentView>(`/agents/${agentId}/top-ups`, input),
    onSuccess: invalidate,
  });
}
