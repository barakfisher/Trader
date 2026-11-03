import { query } from '../pool.js';

/** An article and its instrument links, as the news queries return it. */
export interface ArticleRow {
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

export interface InstrumentArticleRow extends ArticleRow {
  /** Every article in the window, not only this page: `count(*) OVER ()`. */
  total: string;
}

/**
 * A holding's news: articles linked to its instrument, newest first.
 *
 * Ownership goes through `holdings` - articles are shared market data with no
 * `user_id`, so the holding row is what makes this one user's question.
 * `instruments` carries only this holding's link, the one that brought the
 * article here. Syndicated copies (`duplicate_of_id`) are left out: the
 * original carries the links, and one wire story is one item. An undated
 * article is dated by when it was fetched for the window, so it is neither
 * hidden nor given a publication time.
 */
export function listHoldingArticles(
  userId: string,
  agentId: string,
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
      WHERE h.user_id = $1 AND h.agent_id = $2 AND h.id = $3
        AND a.duplicate_of_id IS NULL
        AND coalesce(a.published_at, a.fetched_at) > now() - ($4 || ' days')::interval
      ORDER BY coalesce(a.published_at, a.fetched_at) DESC, a.id
      LIMIT $5`,
    [userId, agentId, holdingId, String(days), limit],
  );
}
