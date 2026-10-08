/**
 * Agents (multi-agent Stage 2): the list, one agent, and the two writes.
 *
 * Writes invalidate the list prefix rather than patching the cache, as the
 * portfolio's do: the server owns every rule about an agent (the budget's
 * cents, the primary being unchangeable), so the cache shows what it stored.
 */

import { queryOptions, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  ActivityResponse,
  AgentAccountResponse,
  AgentInput,
  AgentPerformanceResponse,
  AgentPatchInput,
  AgentScanDetail,
  AgentScansResponse,
  AgentView,
  AgentsResponse,
  RunScanResult,
  TopUpInput,
  TradeInput,
  TradePreview,
  TradeResult,
} from '@traders/shared';

import { api } from '../api/client.ts';
import { queryKeys } from './queryKeys.ts';

export const agentsQuery = queryOptions({
  queryKey: queryKeys.agents,
  queryFn: () => api.get<AgentsResponse>('/agents'),
});

export function useAgentsQuery() {
  return useQuery({ ...agentsQuery, select: (body) => body.agents });
}

/** How many agents count against the installation's limit, and the limit (D72). */
export function useAgentLimitQuery() {
  return useQuery({ ...agentsQuery, select: (body) => body.agentLimit ?? null });
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

/** The agent against the shadow SPY, and its score (D24, D36-D42). Under the agent's key, so a trade refreshes it. */
export function useAgentPerformanceQuery(agentId: string) {
  return useQuery({
    queryKey: queryKeys.agentPerformance(agentId),
    queryFn: () => api.get<AgentPerformanceResponse>(`/agents/${agentId}/performance`),
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

/** The *Decisions* tab (D50): summaries a page at a time, newest first. */
export function useAgentScansQuery(agentId: string) {
  return useInfiniteQuery({
    queryKey: queryKeys.agentScans(agentId),
    queryFn: ({ pageParam }) =>
      api.get<AgentScansResponse>(
        `/agents/${agentId}/scans${pageParam ? `?before=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextBefore,
  });
}

/** One scan in full - briefing and transcript - fetched when its row is opened. */
export function useAgentScanQuery(agentId: string, scanId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.agentScan(agentId, scanId),
    queryFn: () => api.get<AgentScanDetail>(`/agents/${agentId}/scans/${scanId}`),
    enabled,
  });
}

/**
 * *Run a scan now* (D52, D65): waits for the scan, which takes seconds. A
 * proposal it made lands in the inbox and the consolidated view, and the spend
 * and the Decisions tab live under the agent's key.
 */
export function useRunScan(agentId: string) {
  const client = useQueryClient();
  const invalidate = useInvalidateAgents();
  return useMutation({
    mutationFn: () => api.post<RunScanResult>(`/agents/${agentId}/scans`, {}),
    onSettled: () =>
      Promise.all([invalidate(), client.invalidateQueries({ queryKey: queryKeys.proposals })]),
  });
}
