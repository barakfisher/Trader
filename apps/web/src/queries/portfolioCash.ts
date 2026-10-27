/**
 * The real portfolio's cash at the broker (D328-D330, D340-D342): read, opened,
 * moved for a named reason and corrected. Each write refreshes the cash and the
 * portfolio, whose account card adds the two.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { PrimaryCashInput, PrimaryCashMovementInput, PrimaryCashResponse } from '@traders/shared';

import { api } from '../api/client.ts';
import { queryKeys } from './queryKeys.ts';

export function usePrimaryCash() {
  return useQuery({
    queryKey: queryKeys.primaryCash,
    queryFn: () => api.get<PrimaryCashResponse>('/portfolio/cash'),
  });
}

export type CashAction = 'open' | 'correct';

const WRITES: Record<CashAction, (input: PrimaryCashInput) => Promise<PrimaryCashResponse>> = {
  open: (input) => api.post<PrimaryCashResponse>('/portfolio/cash', input),
  correct: (input) => api.put<PrimaryCashResponse>('/portfolio/cash', input),
};

function useCashMutation<Input>(write: (input: Input) => Promise<PrimaryCashResponse>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: write,
    onSuccess: (cash) => {
      client.setQueryData(queryKeys.primaryCash, cash);
      return client.invalidateQueries({ queryKey: queryKeys.portfolio });
    },
  });
}

export function useCashWrite(action: CashAction) {
  return useCashMutation(WRITES[action]);
}

/** A deposit, a withdrawal, income or a charge, each for what it is (D340). */
export function useCashMovement() {
  return useCashMutation((input: PrimaryCashMovementInput) =>
    api.post<PrimaryCashResponse>('/portfolio/cash/movements', input),
  );
}
