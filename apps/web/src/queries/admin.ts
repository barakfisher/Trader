/**
 * The admin surface's reads (M8).
 *
 * Read on arrival and on focus, never polled: an operator opens the page to
 * answer a question, and a page that refetched every few seconds would spend
 * requests on a table nobody is watching.
 */

import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  AccountResetGroup,
  AccountResetInput,
  AccountResetResponse,
  AdminAuditResponse,
  AdminLlmModelsResponse,
  LlmModelChoiceInput,
  LlmScope,
  AdminRunsResponse,
  LlmPanelResponse,
  RescreenStartResponse,
  UniverseGapsResponse,
  UniverseStatusResponse,
} from '@traders/shared';

import { api } from '../api/client.ts';
import { queryKeys } from './queryKeys.ts';

export const adminRunsQuery = queryOptions({
  queryKey: queryKeys.adminRuns,
  queryFn: () => api.get<AdminRunsResponse>('/admin/runs'),
});

export function useAdminRunsQuery() {
  return useQuery(adminRunsQuery);
}

export const adminAuditQuery = queryOptions({
  queryKey: queryKeys.adminAudit,
  queryFn: () => api.get<AdminAuditResponse>('/admin/audit'),
});

export function useAdminAuditQuery() {
  return useQuery(adminAuditQuery);
}

export const adminGapsQuery = queryOptions({
  queryKey: queryKeys.adminGaps,
  queryFn: () => api.get<UniverseGapsResponse>('/admin/gaps'),
});

export function useAdminGapsQuery() {
  return useQuery(adminGapsQuery);
}

export const adminUniverseQuery = queryOptions({
  queryKey: queryKeys.adminUniverse,
  queryFn: () => api.get<UniverseStatusResponse>('/admin/universe'),
});

export function useAdminUniverseQuery() {
  return useQuery(adminUniverseQuery);
}

export function adminLlmQuery(days: number) {
  return queryOptions({
    queryKey: queryKeys.adminLlm(days),
    queryFn: () => api.get<LlmPanelResponse>(`/admin/llm?days=${days}`),
  });
}

export function useAdminLlmQuery(days: number) {
  return useQuery(adminLlmQuery(days));
}

export const adminLlmModelsQuery = queryOptions({
  queryKey: queryKeys.adminLlmModels,
  queryFn: () => api.get<AdminLlmModelsResponse>('/admin/llm/models'),
});

export function useAdminLlmModelsQuery() {
  return useQuery(adminLlmModelsQuery);
}

/** Choose a scope's model (D43). The answer is the page afresh; the audit list gains its row. */
export function useChooseLlmModel() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ scope, model }: { scope: LlmScope; model: string }) =>
      api.put<AdminLlmModelsResponse>(`/admin/llm/models/${scope}`, { model } satisfies LlmModelChoiceInput),
    onSuccess: (body) => {
      client.setQueryData(queryKeys.adminLlmModels, body);
      void client.invalidateQueries({ queryKey: queryKeys.adminAudit });
    },
  });
}

/**
 * Rescreen the universe. The run appears in the runs list at once, and the
 * admin actions list has its audit row; both are refetched rather than polled.
 */
export function useRescreen() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<RescreenStartResponse>('/admin/universe/rescreen', {}),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.adminRuns });
      void client.invalidateQueries({ queryKey: queryKeys.adminAudit });
    },
  });
}

/**
 * Reset the account, by group (task 18). Afterwards almost every cached read
 * describes rows that are gone - the portfolio, findings, proposals, agents,
 * topics - so the whole cache is refetched rather than a list of keys that the
 * next feature would have to remember to extend.
 */
export function useResetAccount() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ groups, confirm }: { groups: AccountResetGroup[]; confirm: string }) =>
      api.post<AccountResetResponse>('/admin/account/reset', { groups, confirm } satisfies AccountResetInput),
    onSuccess: () => {
      void client.invalidateQueries();
    },
  });
}
