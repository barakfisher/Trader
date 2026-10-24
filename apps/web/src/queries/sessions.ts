/** The account's signed-in devices (D261): the list, and signing them out. */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { SessionDevice, SessionDeviceList, SignOutOthersResponse } from '@traders/shared';

import { api } from '../api/client.ts';
import { queryKeys } from './queryKeys.ts';

export function useSessionsQuery() {
  return useQuery({
    queryKey: queryKeys.sessions,
    queryFn: async (): Promise<SessionDevice[]> => (await api.get<SessionDeviceList>('/account/sessions')).sessions,
  });
}

/** Sign one other device out; the list is read again either way, so a row another tab removed goes too. */
export function useSignOutSession() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) => api.delete<void>(`/account/sessions/${encodeURIComponent(sessionId)}`),
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.sessions }),
  });
}

/** Sign out every device but this one (D296). */
export function useSignOutOtherSessions() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<SignOutOthersResponse>('/account/sessions/sign-out-others'),
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.sessions }),
  });
}
