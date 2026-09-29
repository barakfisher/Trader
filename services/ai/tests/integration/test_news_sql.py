"""The headlines discovery reads, through the real SQL.

What is pinned: only distinct headlines inside the window that are linked or
came from the market feed are read, and each carries the symbols of every
instrument it is linked to - the input to a phrase's lead instrument, which
decides whether it is one company's news. And the market feed's pruning deletes
only its own old, unlinked articles (decision 60).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import text
from sqlalchemy.engine import Engine

from app.news.queries import (
    load_market_headlines,
    load_window_headlines,
    prune_market_articles,
)

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


def test_window_headlines_carry_every_linked_symbol(migrated: Engine) -> None:
    with migrated.connect() as connection, connection.begin() as transaction:
        nvda = _instrument(connection, "NVDA")
        msft = _instrument(connection, "MSFT")
        both = _article(connection, "both", "Nvidia and Microsoft build", NOW)
        one = _article(connection, "one", "Nvidia ships", NOW - timedelta(hours=1))
        unlinked = _article(connection, "none", "Rates hold", NOW)
        old = _article(connection, "old", "Nvidia last month", NOW - timedelta(days=30))
        _link(connection, both, nvda)
        _link(connection, both, msft)
        _link(connection, one, nvda)
        _link(connection, old, nvda)

        headlines = load_window_headlines(connection, since=NOW - timedelta(days=7))
        transaction.rollback()

    by_id = {h.article_id: h for h in headlines}
    assert set(by_id) == {both, one}, "an unlinked or out-of-window headline was read"
    assert unlinked not in by_id
    assert by_id[both].instruments == ("MSFT", "NVDA")
    assert by_id[one].instruments == ("NVDA",)


def test_market_headlines_are_read_linked_or_not_and_other_unlinked_ones_are_not(
    migrated: Engine,
) -> None:
    with migrated.connect() as connection, connection.begin() as transaction:
        nvda = _instrument(connection, "NVDA")
        market = _article(connection, "m", "Bond yields spike", NOW, feed="market")
        market_linked = _article(connection, "ml", "Nvidia lifts chip stocks", NOW, feed="market")
        noise = _article(connection, "n", "Fiber-rich breakfasts", NOW)  # the old search API
        _link(connection, market_linked, nvda)

        headlines = load_window_headlines(connection, since=NOW - timedelta(days=7))
        recent = load_market_headlines(connection, since=NOW - timedelta(days=1))
        transaction.rollback()

    by_id = {h.article_id: h for h in headlines}
    assert set(by_id) == {market, market_linked}
    assert noise not in by_id
    assert by_id[market].instruments == ()
    assert by_id[market_linked].instruments == ("NVDA",)
    assert sorted(recent) == [
        ("example.test", "Bond yields spike"),
        ("example.test", "Nvidia lifts chip stocks"),
    ]


def test_pruning_deletes_only_old_unlinked_market_articles(migrated: Engine) -> None:
    before = NOW - timedelta(days=21)
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
