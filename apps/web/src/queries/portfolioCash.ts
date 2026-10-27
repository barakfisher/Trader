/**
 * The real portfolio's cash at the broker (D328-D330): read, opened, deposited
 * into and corrected. Each write refreshes the cash and the portfolio, whose
 * account card adds the two.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { PrimaryCashInput, PrimaryCashResponse } from '@traders/shared';

import { api } from '../api/client.ts';
import { queryKeys } from './queryKeys.ts';

export function usePrimaryCash() {
  return useQuery({
    queryKey: queryKeys.primaryCash,
    queryFn: () => api.get<PrimaryCashResponse>('/portfolio/cash'),
  });
}

export type CashAction = 'open' | 'deposit' | 'correct';

const WRITES: Record<CashAction, (input: PrimaryCashInput) => Promise<PrimaryCashResponse>> = {
  open: (input) => api.post<PrimaryCashResponse>('/portfolio/cash', input),
  deposit: (input) => api.post<PrimaryCashResponse>('/portfolio/cash/deposits', input),
  correct: (input) => api.put<PrimaryCashResponse>('/portfolio/cash', input),
};

export function useCashWrite(action: CashAction) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: WRITES[action],
    onSuccess: (cash) => {
      client.setQueryData(queryKeys.primaryCash, cash);
      return client.invalidateQueries({ queryKey: queryKeys.portfolio });
    },
  });
}
