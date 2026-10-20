/** The account's notification and proposal settings, as the server stores them. */

import { queryOptions, useQuery } from '@tanstack/react-query';

import type { MonthlySpend, MonthlySpendResponse, UserSettingsResponse } from '@traders/shared';

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
