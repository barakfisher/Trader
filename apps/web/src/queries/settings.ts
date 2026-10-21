/** The account's notification and proposal settings, as the server stores them. */

import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  AccountResetGroup,
  AccountResetInput,
  AccountResetResponse,
  MonthlySpend,
  MonthlySpendResponse,
  OwnLlmKeyResponse,
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

/** This month's spend against the user's cap (D157); null for a user without one. */
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

/** Only for a user with a cap: the admin runs on the installation's key, and is refused. */
export function useOwnLlmKeyQuery(enabled: boolean) {
  return useQuery({ ...ownLlmKeyQuery, enabled });
}

/**
 * Save or remove the key. Either changes who pays for the user's calls, so the
 * month's card is read again with the key's new state.
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
