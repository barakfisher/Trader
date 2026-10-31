/**
 * A user's own models (D244, D283-D284): OpenRouter's list as the server
 * filtered it, and what the user chose for Ask, for explanations and for each
 * agent, each with what the next call actually runs on.
 *
 * One read answers every picker and every fallback warning, so the Settings
 * card, an agent's page and the Dashboard banner can never disagree about which
 * model is in use. Each save answers the whole picture afresh.
 */

import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { ModelChoiceInput, ModelChoicesResponse, UserLlmScope } from '@traders/shared';

import { api } from '../api/client.ts';
import { queryKeys } from './queryKeys.ts';

export const modelChoicesQuery = queryOptions({
  queryKey: queryKeys.modelChoices,
  queryFn: () => api.get<ModelChoicesResponse>('/settings/llm-models'),
});

export function useModelChoicesQuery(enabled = true) {
  return useQuery({ ...modelChoicesQuery, enabled });
}

export function useChooseUserModel(scope: UserLlmScope) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (model: string | null) =>
      api.put<ModelChoicesResponse>(`/settings/llm-models/${scope}`, { model } satisfies ModelChoiceInput),
    onSuccess: (body) => client.setQueryData(queryKeys.modelChoices, body),
  });
}

export function useChooseAgentModel(agentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (model: string | null) =>
      api.put<ModelChoicesResponse>(`/agents/${agentId}/model`, { model } satisfies ModelChoiceInput),
    onSuccess: (body) => client.setQueryData(queryKeys.modelChoices, body),
  });
}

/** Every chosen model that has fallen back: the scopes first, then agents in the list's order. */
export function fallbacksOf(
  data: ModelChoicesResponse,
): ({ scope: UserLlmScope; agentId?: undefined } | { scope: 'agent'; agentId: string })[] {
  const found: ({ scope: UserLlmScope; agentId?: undefined } | { scope: 'agent'; agentId: string })[] = [];
  // The admin's Ask and explanations are the Admin page's; only their agents choose here (D352).
  if (!data.admin) {
    for (const scope of ['assistant', 'explain'] as const) {
      if (data.choices[scope].fallback) found.push({ scope });
    }
  }
  for (const agent of data.agents) if (agent.fallback) found.push({ scope: 'agent', agentId: agent.agentId });
  return found;
}
