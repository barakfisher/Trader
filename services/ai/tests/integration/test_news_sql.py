"""The market feed's upkeep and the lexicon re-score, through the real SQL.

What is pinned: the suspected-network check reads every market-feed headline in
its window, linked or not, and nothing else. The market feed's pruning deletes
only its own old, unlinked articles (decision 60), and every key that points at
an article is indexed, so a deleted row is not a scan of the table (D377). And a
lexicon re-score reads only originals the current lexicon has not scored, so it
adds beside older opinions and a second pass finds nothing.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import text
from sqlalchemy.engine import Engine

from app.news.market_feed import SUSPECT_WINDOW
from app.news.queries import (
    count_unscored_articles,
    load_market_headlines,
    load_unscored_articles,
    prune_market_articles,
    store_sentiment,
)
from app.news.sentiment import LEXICON_MODEL_NAME, SentimentScore

NOW = datetime(2026, 9, 29, 12, 0, tzinfo=UTC)


def _article(
    connection: object, key: str, title: str, published: datetime, feed: str = "followed"
) -> str:
    return connection.execute(  # type: ignore[attr-defined]
        text(
            """
            INSERT INTO articles
                   (url_hash, url, source, published_at, title, raw_text, content_hash, feed)
            VALUES (:key, 'https://example.test/' || :key, 'example.test', :published, :title,
                    '', :key, :feed)
            RETURNING id::text
            """
        ),
        {"key": key, "title": title, "published": published, "feed": feed},
    ).scalar_one()


def _instrument(connection: object, symbol: str) -> str:
    return connection.execute(  # type: ignore[attr-defined]
        text("INSERT INTO instruments (symbol) VALUES (:symbol) RETURNING id::text"),
        {"symbol": symbol},
    ).scalar_one()


def _link(connection: object, article_id: str, instrument_id: str) -> None:
    connection.execute(  # type: ignore[attr-defined]
        text(
            """
            INSERT INTO article_entities (article_id, entity_kind, instrument_id, match_method)
            VALUES (CAST(:article AS uuid), 'instrument', CAST(:instrument AS uuid), 'company_name')
            """
        ),
        {"article": article_id, "instrument": instrument_id},
    )


def test_market_headlines_are_read_linked_or_not_and_other_unlinked_ones_are_not(
    migrated: Engine,
) -> None:
    with migrated.connect() as connection, connection.begin() as transaction:
        nvda = _instrument(connection, "NVDA")
        _article(connection, "m", "Bond yields spike", NOW, feed="market")
        market_linked = _article(connection, "ml", "Nvidia lifts chip stocks", NOW, feed="market")
        _article(connection, "n", "Fiber-rich breakfasts", NOW)  # the old search API
        _link(connection, market_linked, nvda)

        recent = load_market_headlines(connection, since=NOW - SUSPECT_WINDOW)
        transaction.rollback()

    assert sorted(recent) == [
        ("example.test", "Bond yields spike"),
        ("example.test", "Nvidia lifts chip stocks"),
    ]


def test_pruning_deletes_only_old_unlinked_market_articles(migrated: Engine) -> None:
    before = NOW - SUSPECT_WINDOW
    with migrated.connect() as connection, connection.begin() as transaction:
        nvda = _instrument(connection, "NVDA")
        gone = _article(
            connection, "old-m", "Old rates story", before - timedelta(hours=1), "market"
        )
        linked = _article(
            connection, "old-ml", "Old Nvidia story", before - timedelta(hours=1), "market"
        )
        fresh = _article(
            connection, "new-m", "New rates story", before + timedelta(hours=1), "market"
        )
        followed = _article(connection, "old-f", "Old followed story", before - timedelta(days=9))
        _link(connection, linked, nvda)
        connection.execute(
            text(
                "INSERT INTO article_sentiment (article_id, score, magnitude, model) "
                "VALUES (CAST(:a AS uuid), 0.1, 0.1, 'lexicon-v1')"
            ),
            {"a": gone},
        )

        pruned = prune_market_articles(connection, before=before)
        left = set(connection.execute(text("SELECT id::text FROM articles")).scalars().all())
        transaction.rollback()

    assert pruned == 1
    assert gone not in left
    assert {linked, fresh, followed} <= left


#: Foreign keys into `articles` whose referencing column leads no index.
SQL_UNINDEXED_KEYS_INTO_ARTICLES = text(
    """
    SELECT c.conrelid::regclass::text || '.' || a.attname
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f'
       AND c.confrelid = 'articles'::regclass
       AND NOT EXISTS (SELECT 1 FROM pg_index i
                        WHERE i.indrelid = c.conrelid AND i.indkey[0] = c.conkey[1])
    """
)


def test_every_foreign_key_into_articles_is_indexed(migrated: Engine) -> None:
    # An unindexed `ON DELETE` key costs one sequential scan of the referencing
    # table per deleted article: 89k pruned rows took 22 minutes on compose.
    with migrated.connect() as connection:
        unindexed = connection.execute(SQL_UNINDEXED_KEYS_INTO_ARTICLES).scalars().all()
    assert unindexed == []


def test_a_rescore_adds_the_current_lexicon_beside_the_old_and_then_finds_nothing(
    migrated: Engine,
) -> None:
    with migrated.connect() as connection, connection.begin() as transaction:
        before = count_unscored_articles(connection, model=LEXICON_MODEL_NAME)
        old = _article(connection, "rs-old", "Webull Sinks 22%", NOW)
        _article(connection, "rs-new", "Shares rally", NOW)
        copy = _article(connection, "rs-copy", "Webull Sinks 22%", NOW)
        connection.execute(
            text(
                "UPDATE articles SET duplicate_of_id = CAST(:o AS uuid) WHERE id = CAST(:c AS uuid)"
            ),
            {"o": old, "c": copy},
        )
        connection.execute(
            text(
                "INSERT INTO article_sentiment (article_id, score, magnitude, model) "
                "VALUES (CAST(:a AS uuid), 0, 0, 'lexicon-v0-test')"
            ),
            {"a": old},
        )

        pending = load_unscored_articles(connection, model=LEXICON_MODEL_NAME, limit=10_000)
        ours = {article_id for article_id, _, _ in pending} & {old, copy}
        for article_id, _, _ in pending:
            store_sentiment(
                connection,
                article_id,
                SentimentScore(score=-1.0, magnitude=0.125, model=LEXICON_MODEL_NAME),
            )
        after = count_unscored_articles(connection, model=LEXICON_MODEL_NAME)
        models = set(
            connection.execute(
                text("SELECT model FROM article_sentiment WHERE article_id = CAST(:a AS uuid)"),
                {"a": old},
            ).scalars()
        )
        transaction.rollback()

    assert len(pending) == before + 2  # the two originals, not the copy
    assert ours == {old}
    assert after == 0
    assert models == {"lexicon-v0-test", LEXICON_MODEL_NAME}
