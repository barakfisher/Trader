/**
 * A topic's tone over a rolling window (PRD FR-12), with the articles behind it.
 *
 * Pure: rows in, one response out. The SQL (`listTopicSentimentRows`) decides
 * which articles belong to the topic; this module decides what they add up to,
 * so the arithmetic is testable without Postgres.
 *
 * **The aggregate is a magnitude-weighted mean**, not a plain one. A lexicon
 * score is a balance of polar words, and an article with one "record" in it
 * scores +1 exactly like an article made of nothing but good news. Weighting by
 * magnitude (how many polar words, saturating) lets the second outweigh the
 * first, and it gives a headline with no polar vocabulary no weight at all -
 * which is right, because it did not express a tone, not because it expressed a
 * neutral one.
 *
 * **Three honest nulls** (`TopicSentimentGap`), never a zero: no articles in the
 * window, articles that no scorer has read, and fewer than
 * `MIN_POLARISED_ARTICLES` articles with any polar language. A score from one
 * article is that article's score with a topic's name on it.
 *
 * **One model at a time.** `lexicon-v1` scores are comparable only with
 * `lexicon-v1` scores (`app/news/sentiment.py`). If a second scorer ever writes
 * beside it, the model that read the most articles in the window is reported
 * and the others are named in `otherModels`, never averaged in.
 *
 * Scores and magnitudes are ratios, not money, so they are numbers here and are
 * rounded once, to `RATIO_PLACES`, on the way out.
 */

import type { TopicSentimentArticle, TopicSentimentResponse } from '@traders/shared';

import type { TopicSentimentRow } from '../db/queries.js';

/** Polarised articles needed before a topic's score is reported. */
export const MIN_POLARISED_ARTICLES = 3;

/** Articles listed as "behind" the score. The counts always cover all of them. */
export const MAX_ARTICLES_BEHIND = 20;

/** The default and the widest window a caller may ask for, in days. */
export const DEFAULT_SENTIMENT_DAYS = 7;
export const MAX_SENTIMENT_DAYS = 30;

const RATIO_PLACES = 4;

interface Scored {
  row: TopicSentimentRow;
  score: number;
  magnitude: number;
}

function ratio(value: number): string {
  // `+0` avoids "-0.0000" for a mean that rounds to zero from below.
  return (+value.toFixed(RATIO_PLACES) + 0).toFixed(RATIO_PLACES);
}

/** The weighted mean of `items`, or null when none of them carries weight. */
function weightedMean(items: Scored[]): number | null {
  const weight = items.reduce((sum, item) => sum + item.magnitude, 0);
  if (weight === 0) return null;
  return items.reduce((sum, item) => sum + item.score * item.magnitude, 0) / weight;
}

/** The model that read the most articles; alphabetical on a tie, so it is stable. */
function primaryModel(rows: TopicSentimentRow[]): { model: string | null; others: string[] } {
  const readers = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.model === null) continue;
    if (!readers.has(row.model)) readers.set(row.model, new Set());
    readers.get(row.model)!.add(row.id);
  }
  const ranked = [...readers.entries()].sort(
    ([a, left], [b, right]) => right.size - left.size || a.localeCompare(b),
  );
  return { model: ranked[0]?.[0] ?? null, others: ranked.slice(1).map(([name]) => name) };
}

export function summariseTopicSentiment(
  topicId: string,
  days: number,
  rows: TopicSentimentRow[],
): TopicSentimentResponse {
  const articleIds = new Set(rows.map((row) => row.id));
  const { model, others } = primaryModel(rows);

  const scored: Scored[] = rows
    .filter((row) => model !== null && row.model === model)
    .map((row) => ({ row, score: Number(row.score), magnitude: Number(row.magnitude) }));
  const polarised = scored.filter((item) => item.magnitude > 0);

  const counts = {
    articles: articleIds.size,
    unscored: articleIds.size - scored.length,
    positive: scored.filter((item) => item.score > 0).length,
    negative: scored.filter((item) => item.score < 0).length,
    neutral: scored.filter((item) => item.score === 0).length,
  };

  let gap: TopicSentimentResponse['gap'] = null;
  if (articleIds.size === 0) gap = 'no_articles';
  else if (scored.length === 0) gap = 'not_scored';
  else if (polarised.length < MIN_POLARISED_ARTICLES) gap = 'too_few_polarised';
  const mean = gap === null ? weightedMean(polarised) : null;

  // Every day in the window that has an article, newest first. A day whose
  // articles carried no weight is null: unmeasured, not neutral.
  const byDay = new Map<string, { ids: Set<string>; items: Scored[] }>();
  for (const row of rows) {
    if (!byDay.has(row.local_day)) byDay.set(row.local_day, { ids: new Set(), items: [] });
    byDay.get(row.local_day)!.ids.add(row.id);
  }
  for (const item of polarised) byDay.get(item.row.local_day)!.items.push(item);
  const daily = [...byDay.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([day, bucket]) => {
      const value = weightedMean(bucket.items);
      return { day, articles: bucket.ids.size, score: value === null ? null : ratio(value) };
    });

  const totalWeight = polarised.reduce((sum, item) => sum + item.magnitude, 0);
  const behind: TopicSentimentArticle[] = [...polarised]
    .sort((a, b) => b.magnitude - a.magnitude || a.row.id.localeCompare(b.row.id))
    .slice(0, MAX_ARTICLES_BEHIND)
    .map(({ row, score, magnitude }) => ({
      id: row.id,
      url: row.url,
      source: row.source,
      title: row.title,
      publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
      score: ratio(score),
      magnitude: ratio(magnitude),
      weight: ratio(magnitude / totalWeight),
    }));

  return {
    topicId,
    days,
    model,
    otherModels: others,
    score: mean === null ? null : ratio(mean),
    gap,
    counts,
    daily,
    behind,
  };
}
