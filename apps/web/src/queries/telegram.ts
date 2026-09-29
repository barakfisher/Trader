/**
 * Whether a Telegram chat is bound to this account.
 *
 * The connect link is not here: it is a bearer credential and lives only in
 * `TelegramStore`, in memory, until the page is left. A cache is exactly the
 * wrong place for it.
 */

import { queryOptions, useQuery } from '@tanstack/react-query';

import type { TelegramBindingResponse } from '@traders/shared';

import { api } from '../api/client.ts';
import { queryKeys } from './queryKeys.ts';

export const telegramBindingQuery = queryOptions({
  queryKey: queryKeys.telegramBinding,
  queryFn: () => api.get<TelegramBindingResponse>('/telegram/binding'),
});

export function useTelegramBindingQuery() {
  return useQuery(telegramBindingQuery);
}
