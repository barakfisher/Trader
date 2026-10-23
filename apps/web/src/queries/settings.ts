/** The account's notification and proposal settings, as the server stores them. */

import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  AccountResetGroup,
  AccountResetInput,
  AccountResetResponse,
  MonthlySpend,
  MonthlySpendResponse,
  OwnLlmKeyResponse,
  SafetyLimitInput,
  SaveOwnLlmKeyRequest,
  UserSettingsResponse,
} from '@traders/shared';

import { api } from '../api/client.ts';
import { queryKeys } from './queryKeys.ts';

export const settingsQuery = queryOptions({
  queryKey: queryKeys.settings,
  queryFn: async () => (await api.get<UserSettingsResponse>('/settings')).settings,
});

export function useSettingsQuery() {
  return useQuery(settingsQuery);
}

/** This month's own-key spend and the user's safety limit (D250); null for the admin. */
export const monthlySpendQuery = queryOptions({
  queryKey: queryKeys.monthlySpend,
  queryFn: async (): Promise<MonthlySpend | null> =>
    (await api.get<MonthlySpendResponse>('/settings/llm-spend')).spend,
});

export function useMonthlySpendQuery() {
  return useQuery(monthlySpendQuery);
}

/** The user's own OpenRouter key (D206): never the key, only its last four and state. */
export const ownLlmKeyQuery = queryOptions({
  queryKey: queryKeys.ownLlmKey,
  queryFn: () => api.get<OwnLlmKeyResponse>('/settings/llm-key'),
});

/** Not for the admin, who runs on the installation's key and is refused (D245). */
export function useOwnLlmKeyQuery(enabled: boolean) {
  return useQuery({ ...ownLlmKeyQuery, enabled });
}

/**
 * Save or remove the key. Either decides whether the user's calls can run at
 * all (D245), so the month's card is read again with the key's new state.
 */
export function useSaveOwnLlmKey() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (apiKey: string) =>
      api.put<OwnLlmKeyResponse>('/settings/llm-key', { apiKey } satisfies SaveOwnLlmKeyRequest),
    onSuccess: (body) => {
      client.setQueryData(queryKeys.ownLlmKey, body);
      void client.invalidateQueries({ queryKey: queryKeys.monthlySpend });
    },
  });
}

export function useRemoveOwnLlmKey() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<OwnLlmKeyResponse>('/settings/llm-key'),
    onSuccess: (body) => {
      client.setQueryData(queryKeys.ownLlmKey, body);
      void client.invalidateQueries({ queryKey: queryKeys.monthlySpend });
    },
  });
}

/** Set or clear the user's monthly safety limit on own-key spend (D250). */
export function useSetSafetyLimit() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (limitMicroUsd: number | null) =>
      api.put<SafetyLimitInput>('/settings/llm-safety-limit', { limitMicroUsd } satisfies SafetyLimitInput),
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.monthlySpend }),
  });
}

/**
 * Reset the signed-in account, by group (task 18; each user's own, D162). Afterwards almost every cached read
 * describes rows that are gone - the portfolio, findings, proposals, agents,
 * topics - so the whole cache is refetched rather than a list of keys that the
 * next feature would have to remember to extend.
 */
export function useResetAccount() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ groups, confirm }: { groups: AccountResetGroup[]; confirm: string }) =>
      api.post<AccountResetResponse>('/account/reset', { groups, confirm } satisfies AccountResetInput),
    onSuccess: () => {
      void client.invalidateQueries();
    },
  });
}
