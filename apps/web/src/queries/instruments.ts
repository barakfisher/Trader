/**
 * Symbol lookup for the add-holding form (D324, D325).
 *
 * The directory is fetched once a session and kept: the server stamps it with
 * an ETag, so even a refetch is an empty 304 while it is unchanged. A provider
 * search is cached per query here and for a day in the AI service.
 */

import { useQuery } from '@tanstack/react-query';

import type {
  InstrumentDirectoryResponse,
  InstrumentQuoteResponse,
  InstrumentSearchResponse,
} from '@traders/shared';

import { api } from '../api/client.ts';
import { queryKeys } from './queryKeys.ts';

/** The directory changes only when the universe is rescreened or a symbol is added. */
export const DIRECTORY_STALE_MS = 24 * 60 * 60_000;
/** A provider's answer to one query, kept for the session's typing. */
export const SEARCH_STALE_MS = 60 * 60_000;
/** A prefill price is the latest one; a minute old is still the latest worth showing. */
export const QUOTE_STALE_MS = 60_000;

export function useInstrumentDirectory() {
  return useQuery({
    queryKey: queryKeys.instrumentDirectory,
    queryFn: () => api.get<InstrumentDirectoryResponse>('/instruments'),
    staleTime: DIRECTORY_STALE_MS,
  });
}

export function useInstrumentSearch(query: string, enabled: boolean) {
  const normalised = query.trim().toLowerCase();
  return useQuery({
    queryKey: queryKeys.instrumentSearch(normalised),
    queryFn: () =>
      api.get<InstrumentSearchResponse>(`/instruments/search?q=${encodeURIComponent(normalised)}`),
    enabled: enabled && normalised.length > 0,
    staleTime: SEARCH_STALE_MS,
  });
}

export function useInstrumentQuote(symbol: string | null) {
  return useQuery({
    queryKey: queryKeys.instrumentQuote(symbol ?? ''),
    queryFn: () => api.get<InstrumentQuoteResponse>(`/instruments/${encodeURIComponent(symbol!)}/quote`),
    enabled: symbol !== null,
    staleTime: QUOTE_STALE_MS,
  });
}
