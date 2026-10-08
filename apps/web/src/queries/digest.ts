/**
 * The daily digest: the next one, and the last one delivered - shown on the
 * Insights page, and announced on the dashboard until it is seen (UX4).
 */

import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { DigestResponse } from '@traders/shared';

import { api } from '../api/client.ts';
import { queryKeys } from './queryKeys.ts';

export const digestQuery = queryOptions({
  queryKey: queryKeys.digest,
  queryFn: () => api.get<DigestResponse>('/notifications/digest'),
});

export function useDigestQuery() {
  return useQuery(digestQuery);
}

/**
 * Mark the digest sent at `sentAt` as seen - opened, or its banner dismissed.
 *
 * The cache says so at once, so the banner leaves on the click rather than a
 * round trip later; the server's answer then replaces the guess. A failed write
 * puts the banner back on the next read, which is the honest outcome: it was
 * not recorded, and another device would still show it.
 */
export function useMarkDigestSeen() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (sentAt: string) => api.post<{ seenAt: string | null }>('/notifications/digest/seen', { sentAt }),
    onMutate: (sentAt) =>
      client.setQueryData<DigestResponse>(queryKeys.digest, (digest) =>
        digest?.last?.sentAt === sentAt ? { ...digest, last: { ...digest.last, seen: true } } : digest,
      ),
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.digest }),
  });
}
