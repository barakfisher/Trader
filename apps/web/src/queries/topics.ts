/**
 * Topics as server state: the list with its limits, and each topic's confirmed
 * instruments, week of news and tone.
 *
 * Keyed per topic, so an answer for a topic that is no longer open lands under
 * its own key and never on the card now showing - which the store used to
 * guarantee by hand, by checking which topic was open when each reply arrived.
 * News and tone are separate queries so a broken sentiment call never hides the
 * news, and neither hides the instruments.
 */

import { queryOptions, useQuery } from '@tanstack/react-query';

import type {
  TopicDetail,
  TopicNewsResponse,
  TopicSentimentResponse,
  TopicsResponse,
} from '@traders/shared';

import { api } from '../api/client.ts';
import { queryKeys } from './queryKeys.ts';

export const topicsQuery = queryOptions({
  queryKey: queryKeys.topics,
  queryFn: () => api.get<TopicsResponse>('/topics'),
});

export function topicQuery(topicId: string) {
  return queryOptions({
    queryKey: queryKeys.topic(topicId),
    queryFn: () => api.get<TopicDetail>(`/topics/${topicId}`),
  });
}

export function topicNewsQuery(topicId: string) {
  return queryOptions({
    queryKey: queryKeys.topicNews(topicId),
    queryFn: () => api.get<TopicNewsResponse>(`/topics/${topicId}/news`),
  });
}

export function topicSentimentQuery(topicId: string) {
  return queryOptions({
    queryKey: queryKeys.topicSentiment(topicId),
    queryFn: () => api.get<TopicSentimentResponse>(`/topics/${topicId}/sentiment`),
  });
}

export function useTopicsQuery() {
  return useQuery(topicsQuery);
}

export function useTopicQuery(topicId: string) {
  return useQuery(topicQuery(topicId));
}

export function useTopicNewsQuery(topicId: string) {
  return useQuery(topicNewsQuery(topicId));
}

export function useTopicSentimentQuery(topicId: string) {
  return useQuery(topicSentimentQuery(topicId));
}
