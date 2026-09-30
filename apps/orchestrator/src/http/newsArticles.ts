/**
 * Articles as the web app receives them, for any subject that has news: a
 * topic (its confirmed instruments) or a holding (its one instrument).
 */

import type { NewsArticle, NewsCollectionState } from '@traders/shared';

import type { TopicArticleRow } from '../db/queries.js';

export function articleOut(row: TopicArticleRow): NewsArticle {
  return {
    id: row.id,
    url: row.url,
    source: row.source,
    title: row.title,
    publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
    fetchedAt: new Date(row.fetched_at).toISOString(),
    instruments: row.instruments.map((link) => ({
      symbol: link.symbol,
      matchMethod: link.match_method,
      matchedText: link.matched_text,
      salience: link.salience,
    })),
    sentiment: row.sentiment,
  };
}

/**
 * The latest finished `news_collect` run, so an empty list can say which empty
 * it is: a quiet week, or news the app could not get.
 */
export function collectionState(run: {
  started_at: Date;
  status: string;
  stats: unknown;
}): NewsCollectionState {
  const failures = (run.stats as { provider_failures?: unknown } | null)?.provider_failures;
  return {
    lastRunAt: run.started_at.toISOString(),
    status: run.status as NewsCollectionState['status'],
    failedProviders: Array.isArray(failures)
      ? failures.filter((f): f is string => typeof f === 'string')
      : [],
  };
}
