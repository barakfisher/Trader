/** The assistant's conversations: the history beside the chat (migration 0052). */

import { queryOptions, useQuery } from '@tanstack/react-query';

import type { AssistantConversationsResponse } from '@traders/shared';

import { api } from '../api/client.ts';
import { queryKeys } from './queryKeys.ts';

export const assistantConversationsQuery = queryOptions({
  queryKey: queryKeys.assistantConversations,
  queryFn: async () =>
    (await api.get<AssistantConversationsResponse>('/assistant/conversations')).conversations,
});

export function useAssistantConversationsQuery() {
  return useQuery(assistantConversationsQuery);
}
