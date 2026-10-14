"""The assistant eval's seeded world, read back through the assistant's own tools.

The eval (`scripts/run_assistant_eval.py`) needs a model and never runs in CI.
Its world does not: if a seed drifts from the schema, or a tool stops seeing
what a case asks about, every case that leans on it fails on a paid run and
reads as the model's mistake. So each fact a case depends on is asked for here
the way the model would ask, with no model.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from sqlalchemy.engine import Engine

from app.agents.scan_schedule import Scheduling
from app.agents.tools import scan_context
from app.analysis.thresholds import AnalysisThresholds
from app.assistant.tools import TOOLS_BY_NAME
from app.core.exchange_calendar import load_calendar
from app.corpus.hashed_embedder import HashedEmbedder
from app.corpus.vector_store import PgVectorStore
from scripts.assistant_eval.market import UNPRICED_SYMBOL, EvalMarket
from scripts.assistant_eval.world import (
    DEMO_HOLDINGS,
    DROPPED_AT_RESCREEN,
    REPO_ROOT,
    TOPIC,
    TOPIC_MEMBERS,
    Account,
    build_database,
    seed_account,
)

NOW = datetime.now(UTC)


@pytest.fixture(scope="module")
def world(engine: Engine, database_url: str) -> Iterator[tuple[Engine, EvalMarket]]:
    asyncio.run(build_database(engine, database_url, NOW))
    yield engine, EvalMarket(str(REPO_ROOT / "data" / "fixtures"))


async def _call(
    world: tuple[Engine, EvalMarket],
    account: Account,
    tool: str,
    scheduling: bool = False,
    **args: Any,
) -> Any:
    """`scheduling` gives the context the runner's: scans scheduled, the real calendar."""
    engine, market = world
    context = scan_context(
        engine=engine,
        market=market,  # type: ignore[arg-type]
        embedder=HashedEmbedder(),
        vector_store=PgVectorStore(),
        thresholds=AnalysisThresholds(),
        excluded_price_sources=(),
        user_id=account.user_id,
        agent_id=account.primary_id,
        now=NOW,
        scheduling=(
            Scheduling(
                enabled=True,
                calendar=load_calendar(str(REPO_ROOT / "data" / "calendar")),
                timezone="Asia/Jerusalem",
            )
            if scheduling
            else None
        ),
    )
    return await TOOLS_BY_NAME[tool].handler(context, args)


async def test_the_demo_portfolio_is_priced_with_a_snapshot(world: Any) -> None:
    account = await seed_account(world[0], world[1], "demo", NOW)

    portfolio = await _call(world, account, "get_portfolio")

    assert {h["symbol"] for h in portfolio["holdings"]} == set(DEMO_HOLDINGS)
    assert all(h["price"] is not None for h in portfolio["holdings"])
    assert portfolio["snapshot"]["total_value"] is not None
    assert all(portfolio["snapshot"]["change_percent"].values())
    assert portfolio["cash"] is None  # the real portfolio keeps no cash
    assert portfolio["cash_note"]  # ... and says so (`account-cash`)
    assert portfolio["today"]["change"] is not None  # `account-today`


async def test_the_agents_have_a_month_and_a_next_scan(world: Any) -> None:
    """`account-best-agent` compares the same month; `product-next-scan` names a slot."""
    account = await seed_account(world[0], world[1], "demo", NOW)

    agents = await _call(world, account, "get_agents", scheduling=True)

    simulated = {a["name"]: a for a in agents["agents"] if not a["real"]}
    assert set(simulated) == {"Momentum", "Value"}
    for agent in simulated.values():
        assert agent["cash"] in ("6000.00", "7500.00")  # what the scans' theses quote
        assert agent["month_to_date"]["change_percent"] is not None
        assert agent["next_scan"]["at"] is not None


async def test_a_week_of_history_has_a_weekly_figure(world: Any) -> None:
    """`followup-nvda-amd`: "how did NVDA do this week?" needs a 5-day return."""
    account = await seed_account(world[0], world[1], "demo", NOW)

    for symbol in ("NVDA", "AMD"):
        history = await _call(world, account, "get_price_history", symbol=symbol, days=5)
        assert history["change_percent"]["5d"] is not None, symbol


async def test_the_unpriced_fixture_has_one_unpriced_holding(world: Any) -> None:
    account = await seed_account(world[0], world[1], "unpriced", NOW)

    portfolio = await _call(world, account, "get_portfolio")

    assert portfolio["unpriced"] == [UNPRICED_SYMBOL]


async def test_the_empty_fixture_has_nothing_but_the_real_portfolio(world: Any) -> None:
    account = await seed_account(world[0], world[1], "empty", NOW)

    portfolio = await _call(world, account, "get_portfolio")
    agents = await _call(world, account, "get_agents")

    assert portfolio["holdings"] == []
    assert [a["real"] for a in agents["agents"]] == [True]


async def test_the_proposals_the_cases_ask_about(world: Any) -> None:
    account = await seed_account(world[0], world[1], "demo", NOW)

    pending = await _call(world, account, "get_proposals")
    rejected = await _call(world, account, "get_proposals", state="rejected")

    assert [(p["kind"], p["trade"]["symbol"], p["agent"]) for p in pending["proposals"]] == [
        ("buy", "SMR", "Momentum")
    ]
    assert [(p["kind"], p["trade"]["symbol"], p["agent"]) for p in rejected["proposals"]] == [
        ("sell", "URA", "Value")
    ]
    assert TOPIC in pending["proposals"][0]["thesis"]


async def test_each_agents_last_scan_replays(world: Any) -> None:
    account = await seed_account(world[0], world[1], "demo", NOW)

    momentum = await _call(world, account, "replay_scan", agent="Momentum")
    value = await _call(world, account, "replay_scan", agent="Value")
    latest = await _call(world, account, "replay_scan")

    assert momentum["outcome"] == "trade" and momentum["decision"]["symbol"] == "SMR"
    assert [s["tool"] for s in momentum["steps"]] == ["search_universe", "get_quote", "get_news"]
    assert value["outcome"] == "invalid_answer" and value["scan_error"]
    assert latest["agent"] == "Value"  # "my agent's last scan" is Value's
    assert momentum["briefing"]["followed_topics"] == [TOPIC]


async def test_the_drawdown_alert_was_raised_yesterday_and_is_high(world: Any) -> None:
    account = await seed_account(world[0], world[1], "demo", NOW)

    found = await _call(world, account, "get_observations", kind="drawdown")

    (alert,) = found["observations"]
    assert alert["subject"] == "instrument:SMR"
    assert alert["severity"] == "high"
    created = datetime.fromisoformat(alert["created_at"])
    assert NOW - timedelta(days=2) < created < NOW


async def test_the_topic_its_members_and_its_move(world: Any) -> None:
    account = await seed_account(world[0], world[1], "demo", NOW)

    (topic,) = (await _call(world, account, "get_topics"))["topics"]

    assert topic["topic"] == TOPIC
    assert {i["symbol"] for i in topic["instruments"]} == set(TOPIC_MEMBERS)
    assert topic["latest_move"] is not None


async def test_the_universe_its_rescreen_and_a_lookup(world: Any) -> None:
    account = await seed_account(world[0], world[1], "demo", NOW)

    info = await _call(world, account, "get_universe_info", symbol="RIVN")

    assert info["last_rescreen"]["dropped"] == len(DROPPED_AT_RESCREEN)
    assert info["dropped_symbols"] == sorted(DROPPED_AT_RESCREEN)
    assert info["symbol"]["known"] is True
    assert info["rules"]["min_stock_market_cap"] is not None


@pytest.mark.parametrize("symbol", ["SMR", "TSLA", "XOM", "NVDA"])
async def test_news_the_cases_ask_about_is_stored(world: Any, symbol: str) -> None:
    account = await seed_account(world[0], world[1], "demo", NOW)

    news = await _call(world, account, "get_news", symbol=symbol, days=7)

    assert news["articles"], symbol


async def test_quotes_are_delayed_and_an_unknown_symbol_is_unpriced(world: Any) -> None:
    account = await seed_account(world[0], world[1], "demo", NOW)

    quotes = await _call(world, account, "get_quote", symbols=["AMD", "NVDA", "ZZZQX"])

    assert set(quotes["quotes"]) == {"AMD", "NVDA"}
    assert all(q["delayed_minutes"] > 0 for q in quotes["quotes"].values())
    assert quotes["unpriced"] == ["ZZZQX"]


async def test_the_concept_corpus_is_loaded(world: Any) -> None:
    account = await seed_account(world[0], world[1], "demo", NOW)

    found = await _call(world, account, "explain_concept", query="drawdown")

    assert any(e["concept"] == "drawdown" for e in found["excerpts"])
