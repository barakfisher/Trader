/**
 * The explanation behind a concept chip (FR-16: any term is one click from an
 * explanation).
 *
 * **Read once a session and never refetched.** The corpus is curated prose that
 * changes when somebody edits a file and re-runs the ingester, not with the
 * market - so a reader who opens `drawdown` on three different observations
 * should pay for one request, not three. This is the one thing in the app where
 * a stale read is harmless: a definition that is five minutes out of date is
 * still the definition.
 *
 * **A missing concept is a state, not an error.** An environment that has not
 * ingested the corpus answers 404 for every slug, and that has to read as "no
 * explanation available" rather than as a broken page. A 404 is therefore
 * resolved as `null`, never thrown, and never retried.
 */

import { queryOptions, useQuery } from '@tanstack/react-query';

import type { ConceptDocument } from '@traders/shared';

import { ApiRequestError, api } from '../api/client.ts';
import { queryKeys } from './queryKeys.ts';

export function conceptQuery(slug: string) {
  return queryOptions({
    queryKey: queryKeys.concept(slug),
    queryFn: async (): Promise<ConceptDocument | null> => {
      try {
        return await api.get<ConceptDocument>(`/concepts/${encodeURIComponent(slug)}`);
      } catch (error) {
        if (error instanceof ApiRequestError && error.status === 404) return null;
        throw error;
      }
    },
    staleTime: Infinity,
  });
}

/** The open concept, or nothing while no chip is open. */
export function useConceptQuery(slug: string | null) {
  return useQuery({ ...conceptQuery(slug ?? ''), enabled: slug !== null });
}
