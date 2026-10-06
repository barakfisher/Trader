"""An agent's read-only tools (D15), through the real SQL.

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
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.engine import Engine

from app.agents.tools import (
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
from app.corpus.hashed_embedder import HashedEmbedder
from app.corpus.vector_store import PgVectorStore
from app.models import DailyClose, Quote
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
            text("INSERT INTO users (role) VALUES ('user') RETURNING id::text")
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

    answer = await get_price_history(context, {"symbol": "nem", "days": 365})

    assert market.history_calls == ["NEM"], "fewer than the minimum stored, so it backfills"
    assert answer["last_close"] == "119.90"
    assert answer["high"] == "119.90" and answer["low"] == "100.00"
    assert answer["change_pct"]["5d"] == "0.42"
    assert len(answer["closes"]) <= MAX_HISTORY_POINTS
    assert answer["closes"][-1] == {
        "date": (NOW - timedelta(days=1)).date().isoformat(),
        "close": "119.90",
    }
    assert "sampling" in answer

    # Now stored, a second call reads the database and leaves the provider alone.
    await get_price_history(context, {"symbol": "NEM", "days": 30})
    assert market.history_calls == ["NEM"]


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
