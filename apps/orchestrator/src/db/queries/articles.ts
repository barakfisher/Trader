import { query } from '../pool.js';

export interface TopicArticleRow {
  id: string;
  url: string;
  source: string;
  title: string;
  published_at: Date | null;
  fetched_at: Date;
  instruments: {
    symbol: string;
    match_method: string;
    matched_text: string | null;
    salience: string;
  }[];
  sentiment: { score: string; magnitude: string; model: string } | null;
}

/**
 * A topic's news: articles linked to any of its confirmed instruments.
 *
 * Derived here rather than stored as topic links, because articles are shared
 * market data and a topic is one user's choice (migration 0018). Syndicated
 * copies (`duplicate_of_id`) are left out: the original carries the links, and
 * one wire story is one item. An undated article is dated by when it was fetched
 * for the window, so it is neither hidden nor given a publication time.
 */
export function listTopicArticles(
  userId: string,
  topicId: string,
  days: number,
  limit = 30,
): Promise<TopicArticleRow[]> {
  return query<TopicArticleRow>(
    `SELECT a.id, a.url, a.source, a.title, a.published_at, a.fetched_at,
            json_agg(json_build_object(
              'symbol', i.symbol,
              'match_method', ae.match_method,
              'matched_text', ae.matched_text,
              'salience', ae.salience::text
            ) ORDER BY ae.salience DESC, i.symbol) AS instruments,
            (SELECT json_build_object('score', s.score::text, 'magnitude', s.magnitude::text,
                                      'model', s.model)
               FROM article_sentiment s
              WHERE s.article_id = a.id
              ORDER BY s.created_at DESC
              LIMIT 1) AS sentiment
       FROM topic_instruments ti
       JOIN article_entities ae ON ae.instrument_id = ti.instrument_id
       JOIN articles a ON a.id = ae.article_id
       JOIN instruments i ON i.id = ti.instrument_id
      WHERE ti.user_id = $1 AND ti.topic_id = $2
        AND a.duplicate_of_id IS NULL
        AND coalesce(a.published_at, a.fetched_at) > now() - ($3 || ' days')::interval
      GROUP BY a.id
      ORDER BY coalesce(a.published_at, a.fetched_at) DESC, a.id
      LIMIT $4`,
    [userId, topicId, String(days), limit],
  );
}

export interface InstrumentArticleRow extends TopicArticleRow {
  /** Every article in the window, not only this page: `count(*) OVER ()`. */
  total: string;
}

/**
 * A holding's news: articles linked to its instrument, newest first.
 *
 * Ownership goes through `holdings` - articles are shared market data with no
 * `user_id`, so the holding row is what makes this one user's question. Shaped
 * like `listTopicArticles` so both render with one component; `instruments`
 * carries only this holding's link, the one that brought the article here.
 */
export function listHoldingArticles(
  userId: string,
  holdingId: string,
  days: number,
  limit = 20,
): Promise<InstrumentArticleRow[]> {
  return query<InstrumentArticleRow>(
    `SELECT a.id, a.url, a.source, a.title, a.published_at, a.fetched_at,
            json_build_array(json_build_object(
              'symbol', i.symbol,
              'match_method', ae.match_method,
              'matched_text', ae.matched_text,
              'salience', ae.salience::text
            )) AS instruments,
            (SELECT json_build_object('score', s.score::text, 'magnitude', s.magnitude::text,
                                      'model', s.model)
               FROM article_sentiment s
              WHERE s.article_id = a.id
              ORDER BY s.created_at DESC
              LIMIT 1) AS sentiment,
            count(*) OVER ()::text AS total
       FROM holdings h
       JOIN instruments i ON i.id = h.instrument_id
       JOIN article_entities ae ON ae.instrument_id = h.instrument_id
       JOIN articles a ON a.id = ae.article_id
      WHERE h.user_id = $1 AND h.id = $2
        AND a.duplicate_of_id IS NULL
        AND coalesce(a.published_at, a.fetched_at) > now() - ($3 || ' days')::interval
      ORDER BY coalesce(a.published_at, a.fetched_at) DESC, a.id
      LIMIT $4`,
    [userId, holdingId, String(days), limit],
  );
}

export interface TopicSentimentRow {
  id: string;
  url: string;
  source: string;
  title: string;
  published_at: Date | null;
  fetched_at: Date;
  /** The article's day in the user's timezone, `YYYY-MM-DD`. */
  local_day: string;
  /** Null for an article no scorer has read. */
  model: string | null;
  score: string | null;
  magnitude: string | null;
}

/**
 * Every opinion on every article in a topic's window, one row per (article, model).
 *
 * The same article set as `listTopicArticles` - linked through a confirmed
 * instrument, syndicated copies excluded - but unlimited within the window,
 * because an average over the first thirty articles is not the topic's average.
 * Articles no scorer has read come back with a null model, so the caller can say
 * how many were left out rather than silently shrinking the denominator. Days are
 * bucketed in the user's timezone (guideline 10).
 */
export function listTopicSentimentRows(
  userId: string,
  topicId: string,
  days: number,
  timezone: string,
): Promise<TopicSentimentRow[]> {
  return query<TopicSentimentRow>(
    `WITH linked AS (
       SELECT DISTINCT a.id, a.url, a.source, a.title, a.published_at, a.fetched_at,
              coalesce(a.published_at, a.fetched_at) AS dated_at
         FROM topic_instruments ti
         JOIN article_entities ae ON ae.instrument_id = ti.instrument_id
         JOIN articles a ON a.id = ae.article_id
        WHERE ti.user_id = $1 AND ti.topic_id = $2
          AND a.duplicate_of_id IS NULL
          AND coalesce(a.published_at, a.fetched_at) > now() - ($3 || ' days')::interval
     )
     SELECT l.id, l.url, l.source, l.title, l.published_at, l.fetched_at,
            to_char((l.dated_at AT TIME ZONE $4)::date, 'YYYY-MM-DD') AS local_day,
            s.model, s.score::text AS score, s.magnitude::text AS magnitude
       FROM linked l
       LEFT JOIN article_sentiment s ON s.article_id = l.id
      ORDER BY l.dated_at DESC, l.id, s.model
      LIMIT 2000`,
    [userId, topicId, String(days), timezone],
  );
}
