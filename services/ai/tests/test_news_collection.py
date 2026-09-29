"""One collection run: the real fixture provider, the real matcher, an in-memory table.

What matters here is not the pipeline (`test_news_ingestion.py` owns that) but the
three decisions this layer makes: who the matcher knows about, which window is
fetched, and that a second run over the same window writes nothing.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

from app.news import FixtureNewsProvider, LexiconSentimentScorer
from app.news.article import RawArticle
from app.news.collection import collect_news
from app.news.entities import InstrumentRef
from app.news.market_feed import SUSPECT_MIN_HEADLINES, SUSPECT_WINDOW
from app.news.queries import (
    SQL_ARTICLE_ID_BY_URL_HASH,
    SQL_INSERT_ARTICLE,
    SQL_KNOWN_HASHES,
    SQL_MARKET_HEADLINES,
    SQL_PRUNE_MARKET_ARTICLES,
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
            return _Result(
                [
                    SimpleNamespace(url_hash=row["url_hash"], content_hash=row["content_hash"])
                    for row in self.articles.values()
                ]
            )
        if statement is SQL_INSERT_ARTICLE:
            if parameters["url_hash"] in self.articles:
                return _Result([])
            article_id = f"a{len(self.articles)}"
            self.articles[parameters["url_hash"]] = {
                "id": article_id,
                "url_hash": parameters["url_hash"],
                "content_hash": parameters["content_hash"],
                "feed": parameters["feed"],
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


# --- the market feed's upkeep (decision 60) -----------------------------------


class _MarketFeed:
    """A provider that hands over fixed articles, some from the market feed."""

    name = "stub"
    makes_external_requests = False
    batches_requests = True

    def __init__(self, articles: list[RawArticle]) -> None:
        self._articles = articles

    async def fetch_for_symbols(self, symbols, since, *, limit=None, names=None):
        return list(self._articles)

    async def fetch_for_query(self, query, since, *, limit=None):
        return []


class MarketNews(InMemoryNews):
    """Adds the two statements the upkeep runs, recording what they were asked."""

    def __init__(self, recent: list[tuple[str, str]] = (), pruned: int = 0) -> None:
        super().__init__()
        self.recent = list(recent)
        self.pruned = pruned
        self.asked: dict[object, dict] = {}

    def execute(self, statement, parameters):
        if statement is SQL_PRUNE_MARKET_ARTICLES:
            self.asked[statement] = parameters
            return SimpleNamespace(rowcount=self.pruned)
        if statement is SQL_MARKET_HEADLINES:
            self.asked[statement] = parameters
            return _Result([SimpleNamespace(source=s, title=t) for s, t in self.recent])
        return super().execute(statement, parameters)


_NOW = datetime(2026, 9, 29, 12, 0, tzinfo=UTC)


def _raw(title: str, *, market: bool) -> RawArticle:
    return RawArticle(
        url=f"https://news.example/{title}", source="news.example", title=title, body=title,
        published_at=_NOW - timedelta(minutes=5), market=market,
    )  # fmt: skip


async def _collect_market(db: MarketNews, articles: list[RawArticle], **kwargs):
    return await collect_news(
        db, [_MarketFeed(articles)], LexiconSentimentScorer(), [APPLE],
        lookback=timedelta(hours=1), now=_NOW, **kwargs,
    )  # fmt: skip


async def test_each_article_is_stored_with_the_feed_that_let_it_in():
    db = MarketNews()
    stats = await _collect_market(
        db, [_raw("Bond yields spike", market=True), _raw("Apple ships", market=False)]
    )
    assert sorted(row["feed"] for row in db.articles.values()) == ["followed", "market"]
    assert stats["market_articles"] == 1


async def test_unlinked_market_articles_are_pruned_at_the_retention_the_caller_gives():
    db = MarketNews(pruned=7)
    stats = await _collect_market(db, [], market_retention=timedelta(days=21))
    assert db.asked[SQL_PRUNE_MARKET_ARTICLES] == {"before": _NOW - timedelta(days=21)}
    assert stats["pruned"] == 7


async def test_nothing_is_pruned_when_the_caller_names_no_retention():
    db = MarketNews(pruned=7)
    stats = await _collect_market(db, [])
    assert SQL_PRUNE_MARKET_ARTICLES not in db.asked
    assert stats["pruned"] == 0


async def test_a_suspected_network_in_the_last_day_is_reported():
    recent = [("new.example", f"Acme (ACME{i}) shares up") for i in range(SUSPECT_MIN_HEADLINES)]
    db = MarketNews(recent=recent)
    stats = await _collect_market(db, [])
    assert db.asked[SQL_MARKET_HEADLINES] == {"since": _NOW - SUSPECT_WINDOW}
    assert stats["suspected_networks"] == [
        {"source": "new.example", "headlines": SUSPECT_MIN_HEADLINES,
         "templated": SUSPECT_MIN_HEADLINES},
    ]  # fmt: skip
