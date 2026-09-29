/**
 * The one cache of server state.
 *
 * TanStack Query owns every server response; MobX keeps what exists only in
 * the browser - drafts, open dialogs, the current view. Before this, each store
 * hand-wrote the same load/loading/error block with no caching, no
 * de-duplication and no retry, and a store that forgot to reload after a write
 * showed stale data with nothing to say so. Here a write invalidates the query
 * it changed, and every screen reading that query refetches together.
 */

import { QueryClient } from '@tanstack/react-query';

import { ApiRequestError } from '../api/client.ts';

/**
 * How long a response counts as current. Long enough that moving between views
 * does not refetch everything; short enough that prices the orchestrator has
 * refreshed reach the screen without a click.
 */
export const QUERY_STALE_MS = 30_000;

/** Retries after the first failure, for failures a retry can fix. */
export const QUERY_MAX_RETRIES = 2;

/**
 * Retry only what might succeed next time: an unreachable server or a 5xx.
 *
 * A 4xx is an answer, not a fault. Retrying a 401 hides a lapsed session behind
 * seconds of spinner, and retrying a 422 sends the same refused request again.
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= QUERY_MAX_RETRIES) return false;
  if (error instanceof ApiRequestError && error.status >= 400 && error.status < 500) return false;
  return true;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: QUERY_STALE_MS, retry: shouldRetry },
      // A write is never retried automatically: repeating a POST is a decision,
      // and the user is the one who makes it.
      mutations: { retry: false },
    },
  });
}
