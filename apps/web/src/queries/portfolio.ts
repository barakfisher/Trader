/**
 * The valued portfolio, and the three writes that change it.
 *
 * Every write invalidates the portfolio query rather than patching the cached
 * response: valuation, weights and totals are computed by the server, and a
 * client that edited one holding's quantity locally would have to recompute
 * all of them - and would be wrong about FX the moment it tried.
 */

import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { ConsolidatedHoldingsResponse, HoldingInput, PortfolioResponse } from '@traders/shared';

import { api } from '../api/client.ts';
import { queryKeys } from './queryKeys.ts';

export const portfolioQuery = queryOptions({
  queryKey: queryKeys.portfolio,
  queryFn: () => api.get<PortfolioResponse>('/portfolio'),
});

export function usePortfolioQuery() {
  return useQuery(portfolioQuery);
}

/**
 * Every holding across the real portfolio and the simulated agents (D32-D35).
 * Fetched only when a view needs it: the default dashboard shows the real
 * portfolio alone and never asks.
 */
export function useConsolidatedQuery(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.consolidated,
    queryFn: () => api.get<ConsolidatedHoldingsResponse>('/portfolio/consolidated'),
    enabled,
  });
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

/** What an edit changes: the quantity always, the cost per unit only when it was touched. */
export interface HoldingEdit {
  holdingId: string;
  quantity: string;
  /** A decimal per unit in `currency`; null clears it. Absent: left as stored. */
  costBasis?: string | null;
  currency?: string;
}

export function useUpdateHolding() {
  const invalidate = useInvalidatePortfolio();
  return useMutation({
    mutationFn: ({ holdingId, ...fields }: HoldingEdit) =>
      api.patch(`/holdings/${holdingId}`, fields),
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
