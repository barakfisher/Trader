/**
 * The admin surface's reads (M8).
 *
 * Read on arrival and on focus, never polled: an operator opens the page to
 * answer a question, and a page that refetched every few seconds would spend
 * requests on a table nobody is watching.
 */

import { queryOptions, useQuery } from '@tanstack/react-query';

import type {
  AdminAuditResponse,
  AdminRunsResponse,
  UniverseGapsResponse,
  UniverseStatusResponse,
} from '@traders/shared';

import { api } from '../api/client.ts';
import { queryKeys } from './queryKeys.ts';

export const adminRunsQuery = queryOptions({
  queryKey: queryKeys.adminRuns,
  queryFn: () => api.get<AdminRunsResponse>('/admin/runs'),
});

export function useAdminRunsQuery() {
  return useQuery(adminRunsQuery);
}

export const adminAuditQuery = queryOptions({
  queryKey: queryKeys.adminAudit,
  queryFn: () => api.get<AdminAuditResponse>('/admin/audit'),
});

export function useAdminAuditQuery() {
  return useQuery(adminAuditQuery);
}

export const adminGapsQuery = queryOptions({
  queryKey: queryKeys.adminGaps,
  queryFn: () => api.get<UniverseGapsResponse>('/admin/gaps'),
});

export function useAdminGapsQuery() {
  return useQuery(adminGapsQuery);
}

export const adminUniverseQuery = queryOptions({
  queryKey: queryKeys.adminUniverse,
  queryFn: () => api.get<UniverseStatusResponse>('/admin/universe'),
});

export function useAdminUniverseQuery() {
  return useQuery(adminUniverseQuery);
}
