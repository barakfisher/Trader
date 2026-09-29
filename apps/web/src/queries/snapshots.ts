/**
 * The daily portfolio snapshots behind the equity curve, oldest first.
 *
 * Keyed under the portfolio, so a write that invalidates `['portfolio']`
 * refreshes the curve too - a new holding changes today's snapshot once the
 * daily run takes it, and the next read should not be a stale one.
 */

import { queryOptions, useQuery } from '@tanstack/react-query';

import type { SnapshotsResponse } from '@traders/shared';

import { api } from '../api/client.ts';
import { queryKeys } from './queryKeys.ts';

/** A year of days: far more than exist today, and the route's own default. */
export const SNAPSHOT_DAYS = 365;

export const snapshotsQuery = queryOptions({
  queryKey: queryKeys.snapshots,
  queryFn: async () =>
    (await api.get<SnapshotsResponse>(`/portfolio/snapshots?limit=${SNAPSHOT_DAYS}`)).snapshots,
});

export function useSnapshotsQuery() {
  return useQuery(snapshotsQuery);
}
