"""The headlines discovery reads, through the real SQL.

What is pinned: only distinct, linked headlines inside the window are read, and
each carries the symbols of every instrument it is linked to - the input to a
phrase's lead instrument, which decides whether it is one company's news.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import text
from sqlalchemy.engine import Engine

from app.news.queries import load_window_headlines

NOW = datetime(2026, 9, 29, 12, 0, tzinfo=UTC)


def _article(connection: object, key: str, title: str, published: datetime) -> str:
    return connection.execute(  # type: ignore[attr-defined]
        text(
            """
            INSERT INTO articles
                   (url_hash, url, source, published_at, title, raw_text, content_hash)
            VALUES (:key, 'https://example.test/' || :key, 'example.test', :published, :title,
                    '', :key)
            RETURNING id::text
            """
        ),
        {"key": key, "title": title, "published": published},
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
