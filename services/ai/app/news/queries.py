"""Reading and writing the news tables, and nothing else.

The only module in `app/news` that touches the database, mirroring
`app/analysis/quote_history.py`: every statement in the package lives here as a
module constant, so `grep articles` finds all of them at once. SQLAlchemy Core
with bound parameters, never string interpolation.

The caller supplies the connection and owns the transaction. A pass over a
hundred articles is one unit of work: either the corpus gained those articles
with their links and their scores, or it gained none of them. Half-ingested
articles - stored, unlinked - would be invisible to the analysis layer and
indistinguishable from articles about nothing.

Every write is idempotent, because a re-run of a scan must not duplicate rows
(guideline 8). Articles conflict on `url_hash` and do nothing; entity links
conflict on (article, instrument) and update, because a rule change should be
able to correct a link; sentiment conflicts on (article, model) and updates, for
the same reason a re-score exists at all.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import text

from app.core.logging import get_logger
from app.news.article import IngestedArticle
from app.news.ingestion import KnownHashes
from app.news.sentiment import SentimentScore
from app.topics.discovery import Headline

log = get_logger("news.queries")

#: Both hashes for the articles we fetched inside the window being ingested.
#: Bounded by `fetched_at` rather than `published_at`: the question is "have we
#: seen this?", which is about our fetch history, and `published_at` is nullable.
SQL_KNOWN_HASHES = text(
    """
    SELECT url_hash, content_hash
      FROM articles
     WHERE fetched_at >= :since
    """
)

#: DO NOTHING rather than DO UPDATE: the article row is a record of what was
#: published, and re-fetching the same url is not news of a change. RETURNING id
#: yields no row on conflict, which is how the caller learns the article was
#: already held.
SQL_INSERT_ARTICLE = text(
    """
    INSERT INTO articles (
        url_hash, url, source, published_at, title, raw_text, content_hash,
        duplicate_of_id, fetched_at, feed
    )
    VALUES (
        :url_hash, :url, :source, :published_at, :title, :raw_text, :content_hash,
        :duplicate_of_id, :fetched_at, :feed
    )
    ON CONFLICT (url_hash) DO NOTHING
    RETURNING id
    """
)

SQL_ARTICLE_ID_BY_URL_HASH = text("SELECT id FROM articles WHERE url_hash = :url_hash")

#: The conflict target repeats the partial index's predicate, which is how
#: Postgres is told which of the two unique indexes on this table is meant.
SQL_UPSERT_INSTRUMENT_ENTITY = text(
    """
    INSERT INTO article_entities (
        article_id, entity_kind, instrument_id, salience, match_method, matched_text
    )
    VALUES (:article_id, 'instrument', :instrument_id, :salience, :match_method, :matched_text)
    ON CONFLICT (article_id, instrument_id) WHERE instrument_id IS NOT NULL
    DO UPDATE SET
        salience     = EXCLUDED.salience,
        match_method = EXCLUDED.match_method,
        matched_text = EXCLUDED.matched_text
    """
)

#: One current opinion per (article, model). A re-score overwrites that model's
#: own row and leaves every other model's alone.
SQL_UPSERT_SENTIMENT = text(
    """
    INSERT INTO article_sentiment (article_id, score, magnitude, model)
    VALUES (:article_id, :score, :magnitude, :model)
    ON CONFLICT (article_id, model)
    DO UPDATE SET
        score      = EXCLUDED.score,
        magnitude  = EXCLUDED.magnitude,
        created_at = now()
    """
)


def load_known_hashes(connection: object, *, since: datetime) -> KnownHashes:
    """The hashes already held for articles fetched at or after `since`.

    `connection` is typed loosely so a test can pass a stub: the only thing
    required of it is `execute(statement, parameters)`.
    """
    rows = connection.execute(SQL_KNOWN_HASHES, {"since": since})  # type: ignore[attr-defined]
    url_hashes: set[str] = set()
    content_hashes: dict[str, str] = {}
    for row in rows:
        url_hashes.add(row.url_hash)
        # First writer wins, so a later copy points at the earliest article
        # carrying that body rather than at whichever row the scan saw last.
        content_hashes.setdefault(row.content_hash, row.url_hash)
    return KnownHashes(url_hashes=frozenset(url_hashes), content_hashes=content_hashes)


def store_ingested(connection: object, articles: list[IngestedArticle]) -> int:
    """Persist one pass. Returns the number of articles actually inserted.

    A returned count lower than the input length means another writer got there
    first - two overlapping runs, or a retry - which is the dedupe working, not an
    error.
    """
    inserted = 0
    # url_hash -> id, for resolving `duplicate_of_id` within this pass. A copy can
    # arrive in the same batch as its original, whose id did not exist until a
    # moment ago.
    ids_by_url_hash: dict[str, str] = {}

    for item in articles:
        record = item.record
        duplicate_of_id = None
        if item.duplicate_of_url_hash is not None:
            duplicate_of_id = ids_by_url_hash.get(item.duplicate_of_url_hash) or _article_id(
                connection, item.duplicate_of_url_hash
            )
            if duplicate_of_id is None:
                # The original is gone (retention, a manual delete). Storing the
                # copy with a dangling pointer would be worse than storing it as
                # an article in its own right.
                log.info(
                    "news.queries.duplicate_original_missing",
                    url_hash=item.duplicate_of_url_hash,
                )

        result = connection.execute(  # type: ignore[attr-defined]
            SQL_INSERT_ARTICLE,
            {
                "url_hash": record.url_hash,
                "url": record.url,
                "source": record.article.source,
                "published_at": record.article.published_at,
                "title": record.title,
                "raw_text": record.article.body,
                "content_hash": record.content_hash,
                "duplicate_of_id": duplicate_of_id,
                "fetched_at": record.fetched_at,
                "feed": "market" if record.article.market else "followed",
            },
        )
        row = result.first()
        if row is None:
            # Already held under this url_hash: nothing to insert, and nothing to
            # link, because the copy that is already there carries the links.
            continue
        article_id = str(row.id)
        ids_by_url_hash[record.url_hash] = article_id
        inserted += 1

        for link in item.entities:
            if link.instrument_id is None:
                # An unresolved symbol cannot be stored as a foreign key, and
                # inventing an instrument row from a news mention would put
                # unverified securities in the table every holding resolves
                # against. The link is dropped and said out loud.
                log.warning(
                    "news.queries.unresolved_instrument",
                    symbol=link.symbol,
                    url_hash=record.url_hash,
                )
                continue
            connection.execute(  # type: ignore[attr-defined]
                SQL_UPSERT_INSTRUMENT_ENTITY,
                {
                    "article_id": article_id,
                    "instrument_id": link.instrument_id,
                    "salience": link.salience,
                    "match_method": link.match_method,
                    "matched_text": link.matched_text,
                },
            )

        if item.sentiment is not None:
            connection.execute(  # type: ignore[attr-defined]
                SQL_UPSERT_SENTIMENT,
                {
                    "article_id": article_id,
                    "score": item.sentiment.score,
                    "magnitude": item.sentiment.magnitude,
                    "model": item.sentiment.model,
                },
            )

    return inserted


def _article_id(connection: object, url_hash: str) -> str | None:
    row = connection.execute(  # type: ignore[attr-defined]
        SQL_ARTICLE_ID_BY_URL_HASH, {"url_hash": url_hash}
    ).first()
    return str(row.id) if row is not None else None


#: The window's headlines for theme discovery (`app/topics/discovery.py`).
#: Articles linked to an instrument, and articles the market feed kept (decision
#: 60). Not other unlinked articles: those were fetched because a name appeared
#: somewhere in a body, not because they are about anything, and read as themes
#: they are noise (68 of the first 77 real GDELT articles, 2026-09-27). Exact
#: copies are skipped (`duplicate_of_id`); near copies are grouped into stories
#: by the caller. Undated articles are placed by when they were fetched.
SQL_WINDOW_HEADLINES = text(
    """
    SELECT a.id::text AS id, a.title, a.source, a.published_at,
           ARRAY(
               SELECT DISTINCT i.symbol
                 FROM article_entities e
                 JOIN instruments i ON i.id = e.instrument_id
                WHERE e.article_id = a.id
                ORDER BY i.symbol
           ) AS instruments
      FROM articles a
     WHERE a.duplicate_of_id IS NULL
       AND coalesce(a.published_at, a.fetched_at) >= :since
       AND (a.feed = 'market'
            OR EXISTS (SELECT 1 FROM article_entities e WHERE e.article_id = a.id))
     ORDER BY coalesce(a.published_at, a.fetched_at) DESC, a.id
    """
)


def load_window_headlines(connection: object, *, since: datetime) -> list[Headline]:
    """Every distinct headline, linked or from the market feed, published (or, if
    undated, fetched) since `since`, with the symbols of the instruments it is linked to."""
    rows = connection.execute(SQL_WINDOW_HEADLINES, {"since": since})  # type: ignore[attr-defined]
    return [
        Headline(
            article_id=row.id,
            title=row.title,
            source=row.source,
            published_at=row.published_at,
            instruments=tuple(row.instruments or ()),
        )
        for row in rows
    ]


#: Market-feed articles nothing followed is linked to, older than `:before`.
#: Linked ones stay: topic news and sentiment read them, whichever feed brought
#: them. Sentiment rows and entity links go with the article (ON DELETE CASCADE);
#: a copy pointing at a pruned original keeps its row (SET NULL).
SQL_PRUNE_MARKET_ARTICLES = text(
    """
    DELETE FROM articles a
     WHERE a.feed = 'market'
       AND coalesce(a.published_at, a.fetched_at) < :before
       AND NOT EXISTS (SELECT 1 FROM article_entities e WHERE e.article_id = a.id)
    """
)

#: The market feed's recent headlines by outlet, for `suspected_networks`.
SQL_MARKET_HEADLINES = text(
    """
    SELECT source, title
      FROM articles
     WHERE feed = 'market'
       AND coalesce(published_at, fetched_at) >= :since
    """
)


def prune_market_articles(connection: object, *, before: datetime) -> int:
    """Delete unlinked market-feed articles from before `before`. Returns how many."""
    result = connection.execute(SQL_PRUNE_MARKET_ARTICLES, {"before": before})  # type: ignore[attr-defined]
    return int(result.rowcount or 0)


def load_market_headlines(connection: object, *, since: datetime) -> list[tuple[str, str]]:
    """`(source, title)` for every market-feed article since `since`."""
    rows = connection.execute(SQL_MARKET_HEADLINES, {"since": since})  # type: ignore[attr-defined]
    return [(row.source, row.title) for row in rows]


#: A file-based feed's read position (migration 0020). Locked for the run, so two
#: overlapping collections cannot both read the same files and race to advance it.
SQL_LOCK_FEED_CURSOR = text(
    """
    SELECT last_file_at FROM news_feed_cursors WHERE provider = :provider FOR UPDATE
    """
)

SQL_SAVE_FEED_CURSOR = text(
    """
    INSERT INTO news_feed_cursors (provider, last_file_at, updated_at)
    VALUES (:provider, :last_file_at, now())
    ON CONFLICT (provider) DO UPDATE
       SET last_file_at = EXCLUDED.last_file_at, updated_at = now()
     WHERE news_feed_cursors.last_file_at < EXCLUDED.last_file_at
    """
)


class SqlFeedCursor:
    """A `FeedCursor` over `news_feed_cursors`, inside the caller's transaction.

    The move only ever goes forward (the `WHERE` above), so a slow run that
    finishes after a faster one cannot rewind the feed.
    """

    def __init__(self, connection: object, provider: str) -> None:
        self._connection = connection
        self._provider = provider

    def get(self) -> datetime | None:
        row = self._connection.execute(  # type: ignore[attr-defined]
            SQL_LOCK_FEED_CURSOR, {"provider": self._provider}
        ).first()
        return row.last_file_at if row else None

    def set(self, last_file_at: datetime) -> None:
        self._connection.execute(  # type: ignore[attr-defined]
            SQL_SAVE_FEED_CURSOR, {"provider": self._provider, "last_file_at": last_file_at}
        )


#: Originals that `model` has not read yet, oldest first so a rerun resumes where
#: the last one stopped. Copies are skipped for the reason ingestion skips them:
#: the original carries the opinion (`app/news/ingestion.py`).
SQL_UNSCORED_ARTICLES = text(
    """
    SELECT a.id, a.title, a.raw_text
      FROM articles a
     WHERE a.duplicate_of_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM article_sentiment s
                        WHERE s.article_id = a.id AND s.model = :model)
     ORDER BY a.created_at, a.id
     LIMIT :limit
    """
)

SQL_COUNT_UNSCORED_ARTICLES = text(
    """
    SELECT count(*) AS n
      FROM articles a
     WHERE a.duplicate_of_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM article_sentiment s
                        WHERE s.article_id = a.id AND s.model = :model)
    """
)


def count_unscored_articles(connection: object, *, model: str) -> int:
    row = connection.execute(SQL_COUNT_UNSCORED_ARTICLES, {"model": model}).one()  # type: ignore[attr-defined]
    return int(row.n)


def load_unscored_articles(
    connection: object, *, model: str, limit: int
) -> list[tuple[str, str, str]]:
    """(id, title, raw_text) for up to `limit` originals that `model` has not scored."""
    rows = connection.execute(SQL_UNSCORED_ARTICLES, {"model": model, "limit": limit})  # type: ignore[attr-defined]
    return [(str(row.id), row.title, row.raw_text) for row in rows]


def store_sentiment(connection: object, article_id: str, score: SentimentScore) -> None:
    connection.execute(  # type: ignore[attr-defined]
        SQL_UPSERT_SENTIMENT,
        {
            "article_id": article_id,
            "score": score.score,
            "magnitude": score.magnitude,
            "model": score.model,
        },
    )
