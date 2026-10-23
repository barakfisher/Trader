/**
 * The admin surface's reads (M8).
 *
 * Read on arrival and on focus, never polled: an operator opens the page to
 * answer a question, and a page that refetched every few seconds would spend
 * requests on a table nobody is watching.
 */

import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  InstallationKeysView,
  InstallationKeyTestView,
  AdminUsersResponse,
  OneTimePasswordResponse,
  AdminSignupsResponse,
  SignupDecisionResponse,
  AdminSettingsInput,
  AdminSettingsResponse,
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

/** The installation's settings (D72): how many agents a user may have. */
export function useAdminSettingsQuery() {
  return useQuery({
    queryKey: queryKeys.adminSettings,
    queryFn: () => api.get<AdminSettingsResponse>('/admin/settings'),
  });
}

/** Change them. The agents list carries the limit too, so it is re-read. */
export function useUpdateAdminSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: AdminSettingsInput) => api.put<AdminSettingsResponse>('/admin/settings', input),
    onSuccess: (body) => {
      client.setQueryData(queryKeys.adminSettings, body);
      void client.invalidateQueries({ queryKey: queryKeys.adminAudit });
      void client.invalidateQueries({ queryKey: queryKeys.agents });
    },
  });
}

/** Sign-up requests (D188): waiting ones, then recent rejections. */
export function useAdminSignupsQuery() {
  return useQuery({
    queryKey: queryKeys.adminSignups,
    queryFn: () => api.get<AdminSignupsResponse>('/admin/signups'),
  });
}

/** The count on the Admin link, asked only for an admin: anyone else is refused it. */
export function useAdminSignupCountQuery(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.adminSignupCount,
    queryFn: () => api.get<{ pending: number }>('/admin/signups/count'),
    enabled,
  });
}

export type SignupDecisionInput =
  { userId: string; action: 'approve' | 'reject' | 'restore' };

/**
 * Approve, reject or undo a rejection. Whatever the answer - applied, or the
 * request had already moved on in Telegram - the list is read again, so the
 * page shows where every request is now.
 */
export function useDecideSignup() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: SignupDecisionInput) =>
      api.post<SignupDecisionResponse>(
        `/admin/signups/${encodeURIComponent(input.userId)}/${input.action}`,
        // An approval carries no amount: users run on their own key only (D245).
        input.action === 'approve' ? {} : undefined,
      ),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: queryKeys.adminSignups });
      void client.invalidateQueries({ queryKey: queryKeys.adminAudit });
    },
  });
}

/** The user list (D162): operations only. */
export function useAdminUsersQuery() {
  return useQuery({
    queryKey: queryKeys.adminUsers,
    queryFn: () => api.get<AdminUsersResponse>('/admin/users'),
  });
}

function useAdminUserMutation<Input extends { userId: string }, Output>(send: (input: Input) => Promise<Output>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSettled: () => {
      void client.invalidateQueries({ queryKey: queryKeys.adminUsers });
      void client.invalidateQueries({ queryKey: queryKeys.adminAudit });
    },
  });
}

/** Disable or re-enable a user (D239). */
export function useSetUserStatus() {
  return useAdminUserMutation((input: { userId: string; action: 'disable' | 'enable' }) =>
    api.post<{ userId: string; status: string }>(`/admin/users/${encodeURIComponent(input.userId)}/${input.action}`),
  );
}

/** A one-time password the app makes (D162); the answer is the only copy. */
export function useOneTimePassword() {
  return useAdminUserMutation((input: { userId: string }) =>
    api.post<OneTimePasswordResponse>(`/admin/users/${encodeURIComponent(input.userId)}/one-time-password`),
  );
}

/** The installation's provider keys: status, never values (D251, D288). */
export function useAdminKeysQuery() {
  return useQuery({
    queryKey: queryKeys.adminKeys,
    queryFn: () => api.get<InstallationKeysView>('/admin/keys'),
  });
}

/** One free check call with a key. Audited by the server; the audit list gains its row. */
export function useTestInstallationKey() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.post<InstallationKeyTestView>(`/admin/keys/${encodeURIComponent(name)}/test`, {}),
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.adminAudit }),
  });
}
