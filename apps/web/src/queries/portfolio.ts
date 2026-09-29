/**
 * The valued portfolio, and the three writes that change it.
 *
 * Every write invalidates the portfolio query rather than patching the cached
 * response: valuation, weights and totals are computed by the server, and a
 * client that edited one holding's quantity locally would have to recompute
 * all of them - and would be wrong about FX the moment it tried.
 */

import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { HoldingInput, PortfolioResponse } from '@traders/shared';

import { api } from '../api/client.ts';
import { queryKeys } from './queryKeys.ts';

export const portfolioQuery = queryOptions({
  queryKey: queryKeys.portfolio,
  queryFn: () => api.get<PortfolioResponse>('/portfolio'),
});

export function usePortfolioQuery() {
  return useQuery(portfolioQuery);
}

function useInvalidatePortfolio() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: queryKeys.portfolio });
}

export function useAddHolding() {
  const invalidate = useInvalidatePortfolio();
  return useMutation({
    mutationFn: (input: HoldingInput) => api.post('/holdings', input),
    onSuccess: invalidate,
  });
}

export function useUpdateQuantity() {
  const invalidate = useInvalidatePortfolio();
  return useMutation({
    mutationFn: ({ holdingId, quantity }: { holdingId: string; quantity: string }) =>
      api.patch(`/holdings/${holdingId}`, { quantity }),
    onSuccess: invalidate,
  });
}

export function useRemoveHolding() {
  const invalidate = useInvalidatePortfolio();
  return useMutation({
    mutationFn: (holdingId: string) => api.delete(`/holdings/${holdingId}`),
    onSuccess: invalidate,
  });
}
