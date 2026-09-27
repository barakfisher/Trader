"""One collection run: the real fixture provider, the real matcher, an in-memory table.

What matters here is not the pipeline (`test_news_ingestion.py` owns that) but the
three decisions this layer makes: who the matcher knows about, which window is
fetched, and that a second run over the same window writes nothing.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

from app.news import FixtureNewsProvider, LexiconSentimentScorer
from app.news.collection import collect_news
from app.news.entities import InstrumentRef
from app.news.queries import (
    SQL_ARTICLE_ID_BY_URL_HASH,
    SQL_INSERT_ARTICLE,
    SQL_KNOWN_HASHES,
    SQL_UPSERT_INSTRUMENT_ENTITY,
)
from tests.conftest import FIXTURES_DIR

#: The fixture's articles are dated 14-16 September 2026.
AFTER_FIXTURE = datetime(2026, 9, 16, 18, 0, tzinfo=UTC)

APPLE = InstrumentRef(
    symbol="AAPL", name="Apple Inc.", asset_class="equity", instrument_id="i-aapl"
)
NUSCALE = InstrumentRef(
    symbol="SMR", name="NuScale Power Corporation", asset_class="equity", instrument_id="i-smr"
)


class _Result:
    def __init__(self, rows):
        self._rows = rows

    def first(self):
        return self._rows[0] if self._rows else None

    def __iter__(self):
        return iter(self._rows)


class InMemoryNews:
    """Just enough of `articles` and `article_entities` to run `store_ingested` twice."""

    def __init__(self) -> None:
        self.articles: dict[str, dict] = {}
        self.links: list[dict] = []

    def execute(self, statement, parameters):
        if statement is SQL_KNOWN_HASHES:
            return _Result([SimpleNamespace(**row) for row in self.articles.values()])
        if statement is SQL_INSERT_ARTICLE:
            if parameters["url_hash"] in self.articles:
                return _Result([])
            article_id = f"a{len(self.articles)}"
            self.articles[parameters["url_hash"]] = {
                "id": article_id,
                "url_hash": parameters["url_hash"],
                "content_hash": parameters["content_hash"],
            }
            return _Result([SimpleNamespace(id=article_id)])
        if statement is SQL_ARTICLE_ID_BY_URL_HASH:
            row = self.articles.get(parameters["url_hash"])
            return _Result([SimpleNamespace(id=row["id"])] if row else [])
        if statement is SQL_UPSERT_INSTRUMENT_ENTITY:
            self.links.append(parameters)
        return _Result([])


async def _collect(db: InMemoryNews, instruments, *, now=AFTER_FIXTURE, hours=72):
    return await collect_news(
        db,
        [FixtureNewsProvider(str(FIXTURES_DIR))],
        LexiconSentimentScorer(),
        instruments,
        lookback=timedelta(hours=hours),
        now=now,
    )


async def test_articles_are_linked_only_to_the_instruments_the_caller_follows():
    db = InMemoryNews()

    stats = await _collect(db, [APPLE])

    assert stats["inserted"] > 0
    assert set(stats["linked_symbols"]) == {"AAPL"}
    assert {link["instrument_id"] for link in db.links} == {"i-aapl"}


async def test_an_acronym_that_is_also_a_ticker_does_not_link_on_its_own():
    # "Regulator sets a 2027 review window for SMR designs" names no company.
    # The NuScale article names the company, so exactly that one links.
    db = InMemoryNews()

    stats = await _collect(db, [NUSCALE])

    assert stats["linked_symbols"] == {"SMR": 1}


async def test_a_second_run_over_the_same_window_writes_nothing():
    db = InMemoryNews()
    first = await _collect(db, [APPLE])

    again = await _collect(db, [APPLE])

    assert first["inserted"] > 0
    assert again["inserted"] == 0
    assert again["duplicate_urls"] == first["fetched"] - first["empty_bodies"]


async def test_a_window_that_misses_the_fixture_collects_nothing_rather_than_redating_it():
    db = InMemoryNews()

    stats = await _collect(db, [APPLE], now=AFTER_FIXTURE + timedelta(days=30), hours=48)

    assert (stats["fetched"], stats["inserted"]) == (0, 0)
    assert stats["providers_used"] == ["fixture"]
