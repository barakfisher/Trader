"""An agent's read-only tools and its briefing (D15), through the real SQL.

Every tool but one is a query over tables the hermetic suite never sees, and the
one that is not (`get_quote`) still reads the universe to say whether a symbol is
tradable. So the tools are tested here, over a migrated database with the corpus
and the fixture universe ingested the way a deployment ingests them.

The market is scripted rather than the fixture provider: what these tests check
is what a tool does with an answer (the backfill when too few closes are stored,
the decimal strings, the error the model can read), not what a provider says.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.engine import Engine

import app.agents.briefing as briefing_module
from app.agents.briefing import (
    CANDIDATES_PER_TOPIC,
    FOLLOWED_TOPICS_KEY,
    MAX_NEW_LISTINGS,
    MOVERS_PER_LIST,
    NEW_IN_UNIVERSE_KEY,
    NEW_LISTING_DAYS,
    UPCOMING_IPO_DAYS,
    UPCOMING_IPOS_KEY,
    build_briefing,
    followed_topics_section,
    movers_section,
)
from app.agents.mandate import Mandate
from app.agents.tools import (
    MAX_HISTORY_DAYS,
    MAX_HISTORY_POINTS,
    MAX_QUOTE_SYMBOLS,
    MIN_STORED_CLOSES,
    TOOLS,
    ToolContext,
    explain_concept,
    get_findings,
    get_news,
    get_position,
    get_price_history,
    get_quote,
    run_tool,
    scan_context,
    search_universe,
)
from app.analysis.thresholds import AnalysisThresholds
from app.corpus.embeddings import EmbeddingError
from app.corpus.hashed_embedder import HashedEmbedder
from app.corpus.relevance import Relevance
from app.corpus.vector_store import PgVectorStore
from app.models import DailyClose, Mover, Quote
from app.news.on_demand import MemoryFetchMarks, NewsOnDemand
from app.news.yahoo import YahooNewsProvider
from app.topics.resolution import TopicCandidate
from tests.integration.conftest import REPO_ROOT, run_script

FIXTURE_EMBEDDER = {"EMBEDDINGS_PROVIDER": "fixture"}
NOW = datetime(2026, 10, 6, 21, 0, tzinfo=UTC)


class ScriptedMarket:
    """The market data registry's two calls the tools make, answered from a script."""

    def __init__(self) -> None:
        self.prices: dict[str, int] = {}
        self.closes: dict[str, list[DailyClose]] = {}
        self.history_calls: list[str] = []

    async def quotes(
        self, symbols: list[str], _markets: Any = None
    ) -> tuple[list[Quote], list[str]]:
        quotes = [
            Quote(
                symbol=symbol,
                price_minor=self.prices[symbol],
                currency="USD",
                as_of=NOW,
                source="fixture",
                delay_seconds=900,
                previous_close_minor=self.prices[symbol] - 100,
                day_change_pct=1.5,
            )
            for symbol in symbols
            if symbol in self.prices
        ]
        return quotes, [symbol for symbol in symbols if symbol not in self.prices]

    async def history(self, symbol: str, _days: int) -> list[DailyClose]:
        self.history_calls.append(symbol)
        return self.closes.get(symbol, [])


def _daily(symbol: str, prices: list[int]) -> list[DailyClose]:
    """One close a day ending yesterday, oldest first."""
    last = NOW - timedelta(days=1)
    return [
        DailyClose(
            symbol=symbol,
            as_of=last - timedelta(days=len(prices) - 1 - n),
            price_minor=price,
            currency="USD",
            source="yfinance",
        )
        for n, price in enumerate(prices)
    ]


@pytest.fixture(scope="module")
def loaded(migrated: Engine, database_url: str) -> Engine:
    corpus = run_script(
        database_url,
        "scripts/ingest_corpus.py",
        CORPUS_DIR=str(REPO_ROOT / "data" / "corpus"),
        **FIXTURE_EMBEDDER,
    )
    assert corpus.returncode == 0, corpus.stdout + corpus.stderr
    universe = run_script(
        database_url, "scripts/ingest_universe.py", "--fixture", **FIXTURE_EMBEDDER
    )
    assert universe.returncode == 0, universe.stdout + universe.stderr
    return migrated


@pytest.fixture(scope="module")
def owner(loaded: Engine) -> Iterator[tuple[str, str, str]]:
    """A user, a simulated agent with $1,000 of cash, and a second agent of theirs."""
    with loaded.begin() as connection:
        user = connection.execute(
            text(
                "INSERT INTO users (role, status, llm_cap_micro_usd) "
                "VALUES ('user', 'active', 10000000) RETURNING id::text"
            )
        ).scalar_one()
        agents = [
            connection.execute(
                text(
                    "INSERT INTO agents (user_id, slug, name, budget_minor) "
                    "VALUES (CAST(:user AS uuid), :slug, :slug, 100000) RETURNING id::text"
                ),
                {"user": user, "slug": slug},
            ).scalar_one()
            for slug in ("tools-agent", "other-agent")
        ]
    yield user, agents[0], agents[1]


def _context(engine: Engine, owner: tuple[str, str, str], market: ScriptedMarket) -> ToolContext:
    user, agent, _ = owner
    return scan_context(
        engine=engine,
        market=market,  # type: ignore[arg-type]
        embedder=HashedEmbedder(),
        vector_store=PgVectorStore(),
        thresholds=AnalysisThresholds(),
        excluded_price_sources=(),
        user_id=user,
        agent_id=agent,
        now=NOW,
    )


def _instrument(engine: Engine, symbol: str) -> str:
    with engine.connect() as connection:
        return connection.execute(
            text("SELECT id::text FROM instruments WHERE symbol = :s"), {"s": symbol}
        ).scalar_one()


# -- search_universe -------------------------------------------------------------


async def test_search_universe_finds_instruments_by_what_they_do(
    loaded: Engine, owner: tuple[str, str, str]
) -> None:
    answer = await search_universe(
        _context(loaded, owner, ScriptedMarket()), {"query": "uranium mining"}
    )
    symbols = {match["symbol"] for match in answer["matches"]}
    # Word overlap on the fixture embedder, not meaning: any uranium name is a fair hit.
    assert symbols & {"CCJ", "NXE", "UEC", "LEU", "URA"}
    assert "note" not in answer


async def test_search_universe_asks_for_a_query(
    loaded: Engine, owner: tuple[str, str, str]
) -> None:
    answer = await search_universe(_context(loaded, owner, ScriptedMarket()), {"query": "  "})
    assert "error" in answer


# -- get_quote -------------------------------------------------------------------


async def test_get_quote_answers_decimal_strings_and_names_the_unpriced(
    loaded: Engine, owner: tuple[str, str, str]
) -> None:
    market = ScriptedMarket()
    market.prices = {"CCJ": 5_432}
    answer = await get_quote(_context(loaded, owner, market), {"symbols": ["ccj", "NOPE"]})
    ccj = answer["quotes"]["CCJ"]
    assert (ccj["price"], ccj["previous_close"], ccj["currency"]) == ("54.32", "53.32", "USD")
    assert ccj["delayed_minutes"] == 15
    assert ccj["tradable"] is True
    # Unpriced is reported, never zero and never hidden (guideline 7).
    assert answer["unpriced"] == ["NOPE"]


async def test_get_quote_is_not_tradable_outside_the_universe(
    loaded: Engine, owner: tuple[str, str, str]
) -> None:
    with loaded.begin() as connection:
        connection.execute(
            text("INSERT INTO instruments (symbol, currency) VALUES ('EUROPE', 'EUR')")
        )
    market = ScriptedMarket()
    market.prices = {"EUROPE": 1_000}
    answer = await get_quote(_context(loaded, owner, market), {"symbols": ["EUROPE"]})
    assert answer["quotes"]["EUROPE"]["tradable"] is False


async def test_get_quote_refuses_too_many_symbols(
    loaded: Engine, owner: tuple[str, str, str]
) -> None:
    symbols = [f"S{n}" for n in range(MAX_QUOTE_SYMBOLS + 1)]
    answer = await get_quote(_context(loaded, owner, ScriptedMarket()), {"symbols": symbols})
    assert "error" in answer


# -- get_price_history -----------------------------------------------------------


async def test_get_price_history_backfills_then_samples_and_summarises(
    loaded: Engine, owner: tuple[str, str, str]
) -> None:
    market = ScriptedMarket()
    prices = [10_000 + 10 * n for n in range(200)]
    market.closes = {"NEM": _daily("NEM", prices)}
    context = _context(loaded, owner, market)

    answer = await get_price_history(context, {"symbol": "nem", "days": MAX_HISTORY_DAYS})

    assert market.history_calls == ["NEM"], "fewer than the minimum stored, so it backfills"
    assert answer["last_close"] == "119.90"
    assert answer["high"] == "119.90" and answer["low"] == "100.00"
    assert answer["change_percent"]["5d"] == "0.42"
    assert len(answer["closes"]) <= MAX_HISTORY_POINTS
    assert answer["closes"][-1] == {
        "date": (NOW - timedelta(days=1)).date().isoformat(),
        "close": "119.90",
    }
    assert "sampling" in answer

    # Now stored, a second call reads the database and leaves the provider alone.
    await get_price_history(context, {"symbol": "NEM", "days": 30})
    assert market.history_calls == ["NEM"]


async def test_get_price_history_counts_trading_days_across_a_weekend(
    loaded: Engine, owner: tuple[str, str, str]
) -> None:
    """Measured 2026-10-12: `days=5` read as calendar days held three closes over a
    weekend, so the answer's own "5d" was null and "how did it do this week?" had
    no weekly figure."""
    market = ScriptedMarket()
    weekdays = [day for day in range(1, 60) if (NOW - timedelta(days=day)).weekday() < 5][:40]
    market.closes = {
        "ISRG": [
            DailyClose(
                symbol="ISRG",
                as_of=NOW - timedelta(days=day),
                price_minor=40_000 + 100 * n,
                currency="USD",
                source="fixture",
            )
            for n, day in enumerate(reversed(weekdays))
        ]
    }

    answer = await get_price_history(_context(loaded, owner, market), {"symbol": "ISRG", "days": 5})

    assert len(answer["closes"]) == 6, "the last close and the five sessions before it"
    assert answer["change_percent"]["5d"] is not None
    assert answer["change_percent"]["5d"] == answer["change_percent"]["period"]
    # The window it covers is in the answer, so "over the last 5 trading days" is sourced.
    assert answer["trading_days"] == 5


async def test_get_price_history_reports_the_span_it_has_not_the_one_asked_for(
    loaded: Engine, owner: tuple[str, str, str]
) -> None:
    """Asked for the longest window over a short history, it reports the span it has.

    Holds whatever earlier tests in this module stored for ISRG (they share one
    database): no fixture here comes near a year of closes.
    """
    market = ScriptedMarket()
    weekdays = [day for day in range(1, 10) if (NOW - timedelta(days=day)).weekday() < 5][:3]
    market.closes = {
        "ISRG": [
            DailyClose(
                symbol="ISRG",
                as_of=NOW - timedelta(days=day),
                price_minor=40_000 + day,
                currency="USD",
                source="fixture",
            )
            for day in weekdays
        ]
    }
    answer = await get_price_history(
        _context(loaded, owner, market), {"symbol": "ISRG", "days": MAX_HISTORY_DAYS}
    )
    assert 2 <= answer["trading_days"] < MAX_HISTORY_DAYS


async def test_get_price_history_says_when_nothing_is_stored(
    loaded: Engine, owner: tuple[str, str, str]
) -> None:
    answer = await get_price_history(_context(loaded, owner, ScriptedMarket()), {"symbol": "AEM"})
    assert answer["closes"] == [] and "note" in answer


async def test_get_price_history_refuses_unknown_symbols_and_bad_periods(
    loaded: Engine, owner: tuple[str, str, str]
) -> None:
    context = _context(loaded, owner, ScriptedMarket())
    assert "search_universe" in (await get_price_history(context, {"symbol": "ZZZZ"}))["error"]
    assert "error" in await get_price_history(context, {"symbol": "NEM", "days": 2})
    assert "error" in await get_price_history(context, {"symbol": "NEM", "days": "30"})


# -- get_findings ----------------------------------------------------------------


async def test_get_findings_reports_a_drawdown(loaded: Engine, owner: tuple[str, str, str]) -> None:
    market = ScriptedMarket()
    # Flat for two months, then a fall of a quarter over a week.
    prices = [20_000] * 60 + [19_000, 18_000, 17_000, 16_000, 15_000]
    market.closes = {"GDX": _daily("GDX", prices)}

    answer = await get_findings(_context(loaded, owner, market), {"symbol": "GDX"})

    kinds = {finding["kind"] for finding in answer["findings"]}
    assert "drawdown" in kinds
    assert all(finding["evidence"] for finding in answer["findings"])


# -- get_news --------------------------------------------------------------------


async def test_get_news_lists_recent_articles_about_the_symbol_with_sentiment(
    loaded: Engine, owner: tuple[str, str, str]
) -> None:
    xom = _instrument(loaded, "XOM")
    with loaded.begin() as connection:
        for n, (title, age) in enumerate((("Exxon raises output", 1), ("Old news", 10))):
            article = connection.execute(
                text(
                    """
                    INSERT INTO articles (url_hash, url, source, published_at, title, raw_text,
                                          content_hash)
                    VALUES (:h, :u, 'Reuters', :at, :title, 'body', :h) RETURNING id
                    """
                ),
                {
                    "h": f"h{n}",
                    "u": f"https://x/{n}",
                    "at": NOW - timedelta(days=age),
                    "title": title,
                },
            ).scalar_one()
            connection.execute(
                text(
                    "INSERT INTO article_entities (article_id, entity_kind, instrument_id, "
                    "match_method) VALUES (:a, 'instrument', CAST(:i AS uuid), 'cashtag')"
                ),
                {"a": article, "i": xom},
            )
            connection.execute(
                text(
                    "INSERT INTO article_sentiment (article_id, score, model) "
                    "VALUES (:a, 0.4, 'fixture')"
                ),
                {"a": article},
            )

    answer = await get_news(_context(loaded, owner, ScriptedMarket()), {"symbol": "XOM"})

    assert [article["title"] for article in answer["articles"]] == ["Exxon raises output"]
    assert answer["articles"][0]["sentiment"] == "0.4"
    empty = await get_news(_context(loaded, owner, ScriptedMarket()), {"symbol": "SYK"})
    assert empty["articles"] == [] and "note" in empty


async def test_get_news_fetches_a_symbols_headlines_once_an_hour_for_every_agent(
    loaded: Engine, owner: tuple[str, str, str]
) -> None:
    """D57: news on demand, linked by the headline, stored once, read by every agent."""
    asked: list[str] = []
    published = int((NOW - timedelta(hours=2)).timestamp())

    def search(query: str, _count: int) -> list[dict[str, object]]:
        asked.append(query)
        return [
            {
                "title": "Stryker beats on hospital demand",
                "link": "https://y/syk-1",
                "publisher": "Reuters",
                "providerPublishTime": published,
            },
            # Listed for SYK by the vendor, but its headline names nothing we know.
            {
                "title": "Stocks slip as yields climb",
                "link": "https://y/mkt-1",
                "publisher": "Yahoo Finance",
                "providerPublishTime": published,
            },
        ]

    marks = MemoryFetchMarks()
    news = NewsOnDemand(engine=loaded, provider=YahooNewsProvider(search=search), marks=marks)
    context = replace(_context(loaded, owner, ScriptedMarket()), news=news)

    answer = await get_news(context, {"symbol": "SYK"})

    assert asked == ["SYK"]
    assert [article["title"] for article in answer["articles"]] == [
        "Stryker beats on hospital demand"
    ]
    assert answer["articles"][0]["source"] == "Reuters"
    # Within the hour, another agent's call reads the stored rows and fetches nothing.
    user, _agent, other = owner
    other_context = replace(context, agent_id=other)
    again = await get_news(other_context, {"symbol": "SYK"})
    assert asked == ["SYK"]
    assert [article["title"] for article in again["articles"]] == [
        "Stryker beats on hospital demand"
    ]


async def test_a_failed_fetch_gives_the_hour_back_and_the_tool_still_answers(
    loaded: Engine, owner: tuple[str, str, str]
) -> None:
    calls: list[str] = []

    def failing(query: str, _count: int) -> list[dict[str, object]]:
        calls.append(query)
        raise TimeoutError("yahoo is slow")

    news = NewsOnDemand(
        engine=loaded, provider=YahooNewsProvider(search=failing), marks=MemoryFetchMarks()
    )
    context = replace(_context(loaded, owner, ScriptedMarket()), news=news)

    first = await get_news(context, {"symbol": "XOM"})
    await get_news(context, {"symbol": "XOM"})

    assert "articles" in first
    # The mark was released, so the next call tried again.
    assert calls == ["XOM", "XOM"]


# -- get_position ----------------------------------------------------------------


async def test_get_position_shows_this_agents_cash_and_holdings_only(
    loaded: Engine, owner: tuple[str, str, str]
) -> None:
    user, agent, other = owner
    with loaded.begin() as connection:
        for holder, symbol, quantity in (
            (agent, "ISRG", "2.50"),
            (agent, "NXE", "10"),
            (other, "SYK", "1"),
        ):
            connection.execute(
                text(
                    """
                    INSERT INTO holdings (user_id, agent_id, instrument_id, quantity,
                                          cost_basis_minor, opened_at)
                    VALUES (CAST(:u AS uuid), CAST(:a AS uuid), CAST(:i AS uuid),
                            CAST(:q AS numeric), 41050, '2026-09-30')
                    """
                ),
                {"u": user, "a": holder, "i": _instrument(loaded, symbol), "q": quantity},
            )
    context = _context(loaded, owner, ScriptedMarket())

    everything = await get_position(context, {})
    assert everything["cash"] == "1000.00", "a round balance keeps its cents"
    # Never an exponent: ten shares are "10", not Decimal's normalised "1E+1".
    assert everything["holdings"] == [
        {"symbol": "ISRG", "quantity": "2.5", "cost_per_share": "410.50", "opened": "2026-09-30"},
        {"symbol": "NXE", "quantity": "10", "cost_per_share": "410.50", "opened": "2026-09-30"},
    ]
    assert (await get_position(context, {"symbol": "isrg"}))["holdings"][0]["symbol"] == "ISRG"
    none = await get_position(context, {"symbol": "SYK"})
    assert none["holdings"] == [] and none["note"] == "no position in SYK"


# -- explain_concept -------------------------------------------------------------


async def test_explain_concept_answers_short_excerpts_from_the_corpus(
    loaded: Engine, owner: tuple[str, str, str]
) -> None:
    answer = await explain_concept(
        _context(loaded, owner, ScriptedMarket()), {"query": "drawdown from a peak"}
    )
    assert answer["excerpts"]
    assert answer["excerpts"][0]["concept"] in {"drawdown", "peak-to-trough"}


# -- run_tool --------------------------------------------------------------------


async def test_run_tool_answers_the_models_mistakes_as_errors_it_can_read(
    loaded: Engine, owner: tuple[str, str, str]
) -> None:
    context = _context(loaded, owner, ScriptedMarket())
    for name, arguments in (("buy_now", "{}"), ("get_position", "{not json"), ("get_news", "[1]")):
        assert "error" in json.loads(await run_tool(context, name, arguments))
    answer = json.loads(await run_tool(context, "get_position", ""))
    assert answer["cash"] == "1000.00"


def test_every_tool_is_named_once_and_closed_to_extra_arguments() -> None:
    names = [tool.spec.name for tool in TOOLS]
    assert len(names) == len(set(names)) == 7
    assert all(tool.spec.parameters["additionalProperties"] is False for tool in TOOLS)


def test_the_minimum_stored_closes_is_below_what_the_backfill_fetches() -> None:
    # Otherwise a backfill could never satisfy the minimum and every call would refetch.
    from app.agents.tools import FINDINGS_DAYS

    assert MIN_STORED_CLOSES < FINDINGS_DAYS


# -- the briefing ----------------------------------------------------------------


def _mover(symbol: str, kind: str, change: float, price: int = 10_000) -> Mover:
    return Mover(
        symbol=symbol,
        list=kind,  # type: ignore[arg-type]
        change_pct=change,
        price_minor=price,
        currency="USD",
        source="fixture",
    )


async def test_the_briefing_carries_holdings_with_findings_and_movers(
    loaded: Engine,
) -> None:
    with loaded.begin() as connection:
        user = connection.execute(
            text(
                "INSERT INTO users (role, status, llm_cap_micro_usd) "
                "VALUES ('user', 'active', 10000000) RETURNING id::text"
            )
        ).scalar_one()
        agent = connection.execute(
            text(
                "INSERT INTO agents (user_id, slug, name, budget_minor) "
                "VALUES (CAST(:u AS uuid), 'briefed', 'Briefed', 250000) RETURNING id::text"
            ),
            {"u": user},
        ).scalar_one()
        connection.execute(
            text(
                "INSERT INTO holdings "
                "(user_id, agent_id, instrument_id, quantity, cost_basis_minor) VALUES"
                " (CAST(:u AS uuid), CAST(:a AS uuid), CAST(:i AS uuid), 4, 3000)"
            ),
            {"u": user, "a": agent, "i": _instrument(loaded, "UEC")},
        )
    market = ScriptedMarket()
    # The holding fell by a third over the last week: the briefing must say so.
    market.closes = {"UEC": _daily("UEC", [3_000] * 60 + [2_700, 2_400, 2_200, 2_000])}
    context = _context(loaded, (user, agent, agent), market)
    movers = [
        _mover("CCJ", "gainers", 3.1),
        _mover("NXE", "gainers", 9.87654),
        _mover("TSLA", "gainers", 12.0),  # not in the fixture universe
        _mover("LEU", "losers", -4.2),
        _mover("XOM", "most_active", 0.5),
    ]

    briefing = await build_briefing(context, movers)

    assert briefing["cash"] == "2500.00"
    [holding] = briefing["holdings"]
    assert (holding["symbol"], holding["quantity"], holding["cost_per_share"]) == (
        "UEC",
        "4",
        "30.00",
    )
    assert "drawdown" in {finding["kind"] for finding in holding["findings"]}
    assert [m["symbol"] for m in briefing["movers"]["gainers"]] == ["NXE", "CCJ"]
    assert briefing["movers"]["gainers"][0] == {
        "symbol": "NXE",
        "change_percent": "9.88",
        "price": "100.00",
    }
    assert [m["symbol"] for m in briefing["movers"]["losers"]] == ["LEU"]
    assert [m["symbol"] for m in briefing["movers"]["most_active"]] == ["XOM"]
    json.dumps(briefing)  # stored with the transcript as JSON


async def test_the_briefing_says_when_there_are_no_movers(
    loaded: Engine, owner: tuple[str, str, str]
) -> None:
    context = _context(loaded, owner, ScriptedMarket())
    assert "note" in movers_section(context, [])
    outside = movers_section(context, [_mover("TSLA", "gainers", 12.0)])
    assert outside["gainers"] == [] and "universe" in outside["note"]


# -- new listings and upcoming IPOs (D409-D411) -------------------------------------


def _listed(
    engine: Engine,
    symbol: str,
    *,
    cap: int | None,
    days_ago: int,
    currency: str = "USD",
    asset_class: str = "equity",
    sector: str = "Technology",
) -> None:
    with engine.begin() as connection:
        instrument_id = connection.execute(
            text(
                "INSERT INTO instruments (symbol, name, asset_class, currency) "
                "VALUES (:s, :s || ' Inc.', :k, :c) RETURNING id"
            ),
            {"s": symbol, "c": currency, "k": asset_class},
        ).scalar_one()
        connection.execute(
            text(
                """
                INSERT INTO instrument_profiles (instrument_id, description, matching_text, source,
                    license, content_hash, sector, industry, market_cap_minor, size_currency,
                    size_as_of, membership)
                VALUES (:id, 'x', 'x', 'test', 'test', :s, :sector, 'Software', :cap, 'USD',
                        :as_of, 'listed')
                """
            ),
            {
                "id": instrument_id,
                "s": symbol,
                "sector": sector,
                "cap": cap,
                "as_of": NOW - timedelta(days=days_ago),
            },
        )


@pytest.fixture
def new_listings(loaded: Engine) -> Iterator[Engine]:
    symbols = [f"NL{n:02d}" for n in range(MAX_NEW_LISTINGS + 1)]
    for n, symbol in enumerate(symbols):
        _listed(loaded, symbol, cap=(n + 1) * 1_000_000_000_00, days_ago=1)
    _listed(loaded, "NLOLD", cap=10**18, days_ago=NEW_LISTING_DAYS + 1)
    _listed(loaded, "NLGBP", cap=10**18, days_ago=1, currency="GBP")
    yield loaded
    with loaded.begin() as connection:
        connection.execute(
            text("DELETE FROM instruments WHERE symbol = ANY(:symbols)"),
            {"symbols": [*symbols, "NLOLD", "NLGBP"]},
        )


async def test_the_briefing_lists_the_largest_recent_tradable_listings(
    new_listings: Engine, owner: tuple[str, str, str]
) -> None:
    briefing = await build_briefing(_context(new_listings, owner, ScriptedMarket()), [])
    section = briefing[NEW_IN_UNIVERSE_KEY]
    assert len(section) == MAX_NEW_LISTINGS
    # Largest first; one older than the window and one not in USD are left out.
    assert section[0]["symbol"] == f"NL{MAX_NEW_LISTINGS:02d}"
    assert {row["symbol"] for row in section}.isdisjoint({"NLOLD", "NLGBP", "NL00"})
    assert section[0] == {
        "symbol": f"NL{MAX_NEW_LISTINGS:02d}",
        "name": f"NL{MAX_NEW_LISTINGS:02d} Inc.",
        "asset_class": "equity",
        "sector": "Technology",
        "industry": "Software",
        "added_on": (NOW - timedelta(days=1)).date().isoformat(),
    }
    json.dumps(briefing)


async def test_the_briefing_lists_registered_and_priced_ipos_only(
    loaded: Engine, owner: tuple[str, str, str]
) -> None:
    today = NOW.date()
    with loaded.begin() as connection:
        connection.execute(
            text(
                """
                INSERT INTO upcoming_listings (cik, company_name, ticker, stage, stage_on,
                                               filed_on, registered_on, priced_on) VALUES
                  ('0000007701', 'Priced Co', 'PRCD', 'priced', :d1, :d9, :d2, :d1),
                  ('0000007702', 'Registered Co', NULL, 'registered', :d2, :d9, :d2, NULL),
                  ('0000007703', 'Filed Co', NULL, 'filed', :d1, :d1, NULL, NULL),
                  ('0000007704', 'Stale Co', NULL, 'registered', :old, :old, :old, NULL)
                """
            ),
            {
                "d1": today - timedelta(days=1),
                "d2": today - timedelta(days=2),
                "d9": today - timedelta(days=9),
                "old": today - timedelta(days=UPCOMING_IPO_DAYS + 1),
            },
        )
    try:
        briefing = await build_briefing(_context(loaded, owner, ScriptedMarket()), [])
        assert briefing[UPCOMING_IPOS_KEY] == [
            {
                "company": "Priced Co",
                "ticker": "PRCD",
                "stage": "priced",
                "filed_on": (today - timedelta(days=9)).isoformat(),
                "registered_on": (today - timedelta(days=2)).isoformat(),
                "priced_on": (today - timedelta(days=1)).isoformat(),
            },
            {
                "company": "Registered Co",
                "ticker": None,
                "stage": "registered",
                "filed_on": (today - timedelta(days=9)).isoformat(),
                "registered_on": (today - timedelta(days=2)).isoformat(),
            },
        ]
    finally:
        with loaded.begin() as connection:
            connection.execute(text("DELETE FROM upcoming_listings WHERE cik LIKE '00000077%'"))


async def test_an_ipo_does_not_borrow_an_older_companys_ticker(
    loaded: Engine, owner: tuple[str, str, str]
) -> None:
    # CCJ is a screened member of the fixture universe, sized before this filing.
    with loaded.begin() as connection:
        connection.execute(
            text(
                """
                INSERT INTO upcoming_listings (cik, company_name, ticker, stage, stage_on,
                                               registered_on)
                VALUES ('0000007711', 'New Cameco Co', 'CCJ', 'registered', :d, :d)
                """
            ),
            {"d": NOW.date() - timedelta(days=1)},
        )
    try:
        briefing = await build_briefing(_context(loaded, owner, ScriptedMarket()), [])
        [ipo] = briefing[UPCOMING_IPOS_KEY]
        assert (ipo["company"], ipo["ticker"]) == ("New Cameco Co", None)
    finally:
        with loaded.begin() as connection:
            connection.execute(text("DELETE FROM upcoming_listings WHERE cik = '0000007711'"))


async def test_the_briefing_leaves_out_empty_sections(
    loaded: Engine, owner: tuple[str, str, str]
) -> None:
    briefing = await build_briefing(_context(loaded, owner, ScriptedMarket()), [])
    assert NEW_IN_UNIVERSE_KEY not in briefing
    assert UPCOMING_IPOS_KEY not in briefing
    # D414: an agent that follows no topic has no topics section.
    assert FOLLOWED_TOPICS_KEY not in briefing


# -- what the mandate allows, and followed topics (D412-D414) -----------------------

#: Six software companies, largest first, an ETF and an energy company: enough that a
#: list cut before the mandate would come up short.
SOFTWARE = [f"MQ{n:02d}" for n in range(1, CANDIDATES_PER_TOPIC + 2)]
#: Funds larger than every software company, enough to fill `new_in_universe` alone:
#: a list cut before the mandate would hold only these, and the mandate would empty it.
BIG_FUNDS = [f"MQF{n:02d}" for n in range(MAX_NEW_LISTINGS)]
NO_ETFS_SOFTWARE_ONLY = Mandate(allow_etfs=False, sectors=("Technology",))


@pytest.fixture
def mandated(loaded: Engine) -> Iterator[Engine]:
    for n, symbol in enumerate(SOFTWARE):
        _listed(loaded, symbol, cap=(100 - n) * 1_000_000_000_00, days_ago=1)
    _listed(loaded, "MQETF", cap=10**18, days_ago=1, asset_class="etf")
    _listed(loaded, "MQENR", cap=10**18, days_ago=1, sector="Energy")
    for symbol in BIG_FUNDS:
        _listed(loaded, symbol, cap=10**18, days_ago=1, asset_class="etf")
    yield loaded
    with loaded.begin() as connection:
        connection.execute(
            text("DELETE FROM instruments WHERE symbol = ANY(:symbols)"),
            {"symbols": [*SOFTWARE, "MQETF", "MQENR", *BIG_FUNDS]},
        )
        connection.execute(text("DELETE FROM upcoming_listings WHERE cik = '0000007721'"))


async def test_the_briefing_offers_only_what_the_mandate_lets_the_agent_buy(
    mandated: Engine, owner: tuple[str, str, str]
) -> None:
    movers = [
        _mover("MQETF", "gainers", 20.0),
        _mover("MQENR", "gainers", 15.0),
        *(_mover(symbol, "gainers", 10.0 - n) for n, symbol in enumerate(SOFTWARE)),
    ]
    context = _context(mandated, owner, ScriptedMarket())
    unlimited = await build_briefing(context, movers)
    assert [m["symbol"] for m in unlimited["movers"]["gainers"]][:2] == ["MQETF", "MQENR"]

    briefing = await build_briefing(context, movers, mandate=NO_ETFS_SOFTWARE_ONLY)
    # Filtered before the cut: the agent still sees a full list it may buy.
    gainers = [m["symbol"] for m in briefing["movers"]["gainers"]]
    assert gainers == SOFTWARE[:MOVERS_PER_LIST]
    # Every software company, though ten larger funds came first in the window.
    assert [row["symbol"] for row in briefing[NEW_IN_UNIVERSE_KEY]] == SOFTWARE


async def test_an_ipo_whose_ticker_the_agent_blocked_is_left_out(
    mandated: Engine, owner: tuple[str, str, str]
) -> None:
    with mandated.begin() as connection:
        connection.execute(
            text(
                """
                INSERT INTO upcoming_listings (cik, company_name, ticker, stage, stage_on,
                                               registered_on)
                VALUES ('0000007721', 'Blocked Co', 'MQIPO', 'registered', :d, :d)
                """
            ),
            {"d": NOW.date() - timedelta(days=1)},
        )
    context = _context(mandated, owner, ScriptedMarket())
    assert (await build_briefing(context, []))[UPCOMING_IPOS_KEY]
    blocked = await build_briefing(context, [], mandate=Mandate(blocked_symbols=("MQIPO",)))
    assert UPCOMING_IPOS_KEY not in blocked


def _candidate(symbol: str) -> TopicCandidate:
    return TopicCandidate(
        instrument_id="unused",
        symbol=symbol,
        name=f"{symbol} Inc.",
        asset_class="etf" if symbol.endswith("ETF") else "equity",
        sector=None,
        industry="Software",
        similarity=0.5,
        size_minor=None,
        size_currency=None,
        confidence=Relevance.CONFIDENT,
        rationale="unused",
    )


#: What `resolve_topic` answers in these tests: the embedder is not what they test.
RESOLVED = {
    "software": [*SOFTWARE[:2], "MQETF", "NOTAMEMBER", *SOFTWARE[2:]],
    "energy software": [SOFTWARE[1], "MQENR"],
    "held only": [SOFTWARE[0]],
    "hiking": [],
}


@pytest.fixture
def scripted_topics(monkeypatch: pytest.MonkeyPatch) -> None:
    async def resolve(_connection: Any, _embedder: Any, topic: str) -> Any:
        if topic == "broken":
            raise EmbeddingError("the embeddings provider is down")
        candidates = [_candidate(symbol) for symbol in RESOLVED[topic]]
        return SimpleNamespace(interpretations=[SimpleNamespace(candidates=candidates)])

    monkeypatch.setattr(briefing_module, "resolve_topic", resolve)


@pytest.mark.usefixtures("scripted_topics")
async def test_each_followed_topic_offers_what_the_agent_may_buy_and_does_not_hold(
    mandated: Engine, owner: tuple[str, str, str]
) -> None:
    section = await followed_topics_section(
        _context(mandated, owner, ScriptedMarket()),
        ("software", "energy software", "hiking", "broken"),
        Mandate(allow_etfs=False),
        held={SOFTWARE[0]},
    )
    software, energy, hiking, broken = section
    # Not the held one, not the ETF the mandate bans, not a non-member; five at most.
    assert software["topic"] == "software"
    assert [m["symbol"] for m in software["matches"]] == SOFTWARE[1 : CANDIDATES_PER_TOPIC + 1]
    assert software["matches"][0] == {
        "symbol": SOFTWARE[1],
        "name": f"{SOFTWARE[1]} Inc.",
        "kind": "equity",
        "industry": "Software",
        "confidence": Relevance.CONFIDENT,
    }
    # A symbol an earlier topic showed is not shown again.
    assert [m["symbol"] for m in energy["matches"]] == ["MQENR"]
    assert "nothing in the universe" in hiking["note"] and "matches" not in hiking
    assert "could not be searched" in broken["note"]


@pytest.mark.usefixtures("scripted_topics")
async def test_a_topic_whose_every_match_is_taken_says_so(
    mandated: Engine, owner: tuple[str, str, str]
) -> None:
    [held] = await followed_topics_section(
        _context(mandated, owner, ScriptedMarket()), ("held only",), Mandate(), held={SOFTWARE[0]}
    )
    assert "held" in held["note"] and "matches" not in held


@pytest.mark.usefixtures("scripted_topics")
async def test_the_briefing_carries_the_agents_topics(
    mandated: Engine, owner: tuple[str, str, str]
) -> None:
    briefing = await build_briefing(
        _context(mandated, owner, ScriptedMarket()), [], topics=("software",)
    )
    [topic] = briefing[FOLLOWED_TOPICS_KEY]
    assert topic["topic"] == "software" and len(topic["matches"]) == CANDIDATES_PER_TOPIC
    json.dumps(briefing)
