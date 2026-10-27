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
  AgentSuggestionsResponse,
  AgentView,
  AgentsResponse,
  InstructionsCheckResult,
  RunScanResult,
  TopUpInput,
  TradeInput,
  TradePreview,
  TradeResult,
} from '@traders/shared';

import { api } from '../api/client.ts';
import { minutesUntilSoonScan } from '../lib/scanTimes.ts';
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

/** How often an agent is re-read while a scan runs or one is due soon (D195). */
export const AGENT_SCAN_REFRESH_MS = 30_000;

export function useAgentQuery(agentId: string) {
  return useQuery({
    queryKey: queryKeys.agent(agentId),
    queryFn: () => api.get<AgentView>(`/agents/${agentId}`),
    // A scheduled scan starts and ends without the page asking: re-read while
    // one is running or about to, so *Run a scan now* follows it - and only then.
    refetchInterval: (query) => {
      const agent = query.state.data;
      if (!agent) return false;
      return agent.runningScan !== null || minutesUntilSoonScan(agent.scheduling?.nextAt) !== null
        ? AGENT_SCAN_REFRESH_MS
        : false;
    },
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

/**
 * Ask whether an agent's instructions contradict its settings (D176-D178), right
 * after a save. The result is stored on the agent, so the agent list and page read
 * it from their own queries once this invalidates them.
 */
export function useCheckInstructions() {
  const invalidate = useInvalidateAgents();
  return useMutation({
    mutationFn: (agentId: string) => api.post<InstructionsCheckResult>(`/agents/${agentId}/instructions-check`),
    onSuccess: invalidate,
  });
}

export function useDismissInstructionsCheck(agentId: string) {
  const invalidate = useInvalidateAgents();
  return useMutation({
    mutationFn: () => api.post<void>(`/agents/${agentId}/instructions-check/dismiss`),
    onSuccess: invalidate,
  });
}

/** The agent review's open suggestions (D340-D343). Not asked of the primary. */
export function useAgentSuggestionsQuery(agentId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.agentSuggestions(agentId),
    queryFn: () => api.get<AgentSuggestionsResponse>(`/agents/${agentId}/suggestions`),
    enabled,
  });
}

/** Apply writes the suggestion's one setting; the agent and every view of it refresh. */
export function useApplySuggestion(agentId: string) {
  const invalidate = useInvalidateAgents();
  return useMutation({
    mutationFn: (suggestionId: string) => api.post<AgentView>(`/agents/${agentId}/suggestions/${suggestionId}/apply`),
    // A refusal closes or keeps the card on the server's word: read it again either way.
    onSettled: invalidate,
  });
}

export function useDismissSuggestion(agentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (suggestionId: string) => api.post<void>(`/agents/${agentId}/suggestions/${suggestionId}/dismiss`),
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.agentSuggestions(agentId) }),
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
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: TradeInput) => api.post<TradeResult>(`/agents/${agentId}/trades`, input),
    // A trade on the main portfolio (D332) moves its holdings and its cash, both under `portfolio`.
    onSuccess: () => Promise.all([invalidate(), client.invalidateQueries({ queryKey: queryKeys.portfolio })]),
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
