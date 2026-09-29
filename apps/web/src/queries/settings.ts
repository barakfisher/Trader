/** The account's notification and proposal settings, as the server stores them. */

import { queryOptions, useQuery } from '@tanstack/react-query';

import type { UserSettingsResponse } from '@traders/shared';

import { api } from '../api/client.ts';
import { queryKeys } from './queryKeys.ts';

export const settingsQuery = queryOptions({
  queryKey: queryKeys.settings,
  queryFn: async () => (await api.get<UserSettingsResponse>('/settings')).settings,
});

export function useSettingsQuery() {
  return useQuery(settingsQuery);
}
