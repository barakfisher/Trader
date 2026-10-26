/** Sign-in through Google and GitHub (D262, D263): what this installation offers, and what is linked. */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { LinkedIdentity, OAuthProviderName } from '@traders/shared';

import { api } from '../api/client.ts';
import { queryKeys } from './queryKeys.ts';

/** The providers with an app configured; empty where sign-in is by password alone. */
export function useOAuthProvidersQuery() {
  return useQuery({
    queryKey: queryKeys.oauthProviders,
    queryFn: async (): Promise<OAuthProviderName[]> =>
      (await api.get<{ providers: OAuthProviderName[] }>('/auth/oauth/providers')).providers,
    staleTime: Infinity,
  });
}

export function useIdentitiesQuery() {
  return useQuery({
    queryKey: queryKeys.identities,
    queryFn: () => api.get<{ identities: LinkedIdentity[]; available: OAuthProviderName[] }>('/auth/identities'),
  });
}

export function useUnlinkIdentity() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (provider: OAuthProviderName) => api.delete<void>(`/auth/identities/${provider}`),
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.identities }),
  });
}
