"""The agent-scan eval's frozen world through real SQL (D421, D426).

What the hermetic tests cannot see: the frozen market reading the stored series
the tools read, the queries that find a world's agent, briefing and earlier
theses, and a clone that is a separate database and leaves nothing behind.

No dump of production is read: the world here is a few rows on a migrated
database, and the clone is made on the test server itself.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.engine.url import make_url
from sqlalchemy.pool import NullPool

import scripts.run_agent_eval as run_agent_eval
from app.agents.scan_memory import RECENT_SCANS, recent_scans
from app.config import Settings
from app.corpus.hashed_embedder import HashedEmbedder
from app.models import DailyClose
from scripts.agent_eval.cases import Case, World
from scripts.agent_eval.frozen_market import SOURCE, FrozenMarket, newest_briefing
from scripts.agent_eval.frozen_world import (
    OWNER_ROLE,
    WorldError,
    clone,
    connect,
    earlier_theses,
    find_agent_id,
)
from scripts.agent_eval.readings import PASS_OUTCOME
from tests.integration.conftest import alembic
from tests.integration.test_agent_scan_sql import STEP_COST, ScriptedLLM, _trades

CLOCK = datetime(2026, 11, 19, 7, 21, 36, tzinfo=UTC)
AGENT = "frozen-world-agent"
OTHERS_ONLY = "another-user-s-agent"
BUSY_AGENT = "frozen-world-busy-agent"
TEMPLATE = "frozen_world_template_test_ci"
CLONE = "frozen_world_clone_test_ci"
SHOWN = {"movers": {"gainers": [{"symbol": "QLYS", "change_percent": "1.00", "price": "9.00"}]}}


def _quote(connection: Connection, instrument: str, as_of: datetime, minor: int) -> None:
    connection.execute(
        text(
            "INSERT INTO quotes (instrument_id, as_of, price_minor, currency, source) "
            "VALUES (CAST(:i AS uuid), :at, :minor, 'USD', 'yfinance')"
        ),
        {"i": instrument, "at": as_of, "minor": minor},
    )


def _scan(
    connection: Connection,
    user: str,
    agent: str,
    at: datetime,
    *,
    briefing: dict[str, Any],
    answer: dict[str, Any] | None,
    outcome: str = "no_trade",
) -> None:
    connection.execute(
        text(
            "INSERT INTO agent_scans (user_id, agent_id, trigger, briefing, started_at, "
            "finished_at, outcome, answer) VALUES (CAST(:u AS uuid), CAST(:a AS uuid), "
            "'schedule', CAST(:briefing AS jsonb), :at, :at, :outcome, CAST(:answer AS jsonb))"
        ),
        {
            "u": user,
            "a": agent,
            "at": at,
            "outcome": outcome,
            "briefing": json.dumps(briefing),
            "answer": json.dumps(answer) if answer is not None else None,
        },
    )


@pytest.fixture(scope="module")
def world(migrated: Engine) -> tuple[Engine, str, str]:
    """A user's agent with two scans before the clock and one after it, and NVDA with
    a close on each of the three days around the clock."""
    with migrated.begin() as connection:
        user = connection.execute(
            text("INSERT INTO users (role, status) VALUES (:role, 'active') RETURNING id::text"),
            {"role": OWNER_ROLE},
        ).scalar_one()
        other = connection.execute(
            text(
                "INSERT INTO users (role, status, llm_cap_micro_usd) "
                "VALUES ('user', 'active', 10000000) RETURNING id::text"
            )
        ).scalar_one()
        agent = connection.execute(
            text(
                "INSERT INTO agents (user_id, slug, name, budget_minor) "
                "VALUES (CAST(:u AS uuid), :name, :name, 100000) RETURNING id::text"
            ),
            {"u": user, "name": AGENT},
        ).scalar_one()
        # Another user's agents: one that shares the name, one only they have. And more
        # decided scans than the agent is shown as memory, on an agent of the admin's.
        for name in (AGENT, OTHERS_ONLY):
            connection.execute(
                text(
                    "INSERT INTO agents (user_id, slug, name, budget_minor) "
                    "VALUES (CAST(:u AS uuid), :name, :name, 100000)"
                ),
                {"u": other, "name": name},
            )
        busy = connection.execute(
            text(
                "INSERT INTO agents (user_id, slug, name, budget_minor) "
                "VALUES (CAST(:u AS uuid), :name, :name, 100000) RETURNING id::text"
            ),
            {"u": user, "name": BUSY_AGENT},
        ).scalar_one()
        for n in range(RECENT_SCANS + 2):
            _scan(
                connection,
                user,
                busy,
                CLOCK - timedelta(days=n + 1),
                briefing={},
                answer={"trades": [], "thesis": f"reason {n}"},
            )
        nvda = connection.execute(
            text("INSERT INTO instruments (symbol) VALUES ('NVDA') RETURNING id::text")
        ).scalar_one()
        _quote(connection, nvda, CLOCK - timedelta(days=2), 18_000)
        _quote(connection, nvda, CLOCK - timedelta(days=1), 18_240)
        _quote(connection, nvda, CLOCK + timedelta(days=1), 99_999)
        _scan(
            connection,
            user,
            agent,
            CLOCK - timedelta(days=2),
            briefing={"movers": {}},
            answer={"trades": [], "thesis": "the older reason"},
        )
        _scan(
            connection,
            user,
            agent,
            CLOCK - timedelta(hours=9),
            briefing=SHOWN,
            answer={"trades": [{"symbol": "NVDA", "thesis": "the trade's reason"}], "thesis": None},
            outcome="trade",
        )
        _scan(
            connection,
            user,
            agent,
            CLOCK + timedelta(hours=9),
            briefing={"movers": {"note": "after the clock"}},
            answer=None,
            outcome="failed",
        )
    return migrated, user, agent


async def test_a_quote_is_the_stored_close_at_the_clock_never_a_later_one(
    world: tuple[Engine, str, str],
) -> None:
    engine, _, _ = world
    market = FrozenMarket(engine, CLOCK)
    (quote,), missing = await market.quotes(["nvda"])
    assert missing == []
    assert (quote.price_minor, quote.previous_close_minor) == (18_240, 18_000)
    assert quote.as_of == CLOCK - timedelta(days=1)
    assert quote.source == SOURCE


async def test_a_stored_close_wins_over_a_fetched_one_and_an_unknown_symbol_is_unpriced(
    world: tuple[Engine, str, str],
) -> None:
    engine, _, _ = world
    fetched = DailyClose(
        symbol="NVDA",
        as_of=CLOCK - timedelta(days=1),
        price_minor=1,
        currency="USD",
        source="yfinance",
    )
    market = FrozenMarket(engine, CLOCK, closes={"NVDA": [fetched]})
    quotes, missing = await market.quotes(["NVDA", "NOPE"])
    assert [quote.price_minor for quote in quotes] == [18_240]
    assert missing == ["NOPE"] == market.unpriced


def test_the_agent_is_found_by_name_and_a_name_with_no_agent_is_refused(
    world: tuple[Engine, str, str],
) -> None:
    engine, user, agent = world
    # Another user has an agent of the same name: the admin's is the one found.
    assert find_agent_id(engine, AGENT) == (user, agent)
    with pytest.raises(WorldError):
        find_agent_id(engine, "nobody by this name")


def test_an_agent_only_another_user_has_is_never_the_case_s_agent(
    world: tuple[Engine, str, str],
) -> None:
    engine, _, _ = world
    with engine.connect() as connection:
        owners = connection.execute(
            text("SELECT count(*) FROM agents WHERE name = :name"), {"name": OTHERS_ONLY}
        ).scalar_one()
    assert owners == 1  # the agent is there; it is not the admin's
    with pytest.raises(WorldError):
        find_agent_id(engine, OTHERS_ONLY)


def test_the_briefing_shown_is_the_newest_before_the_clock(
    world: tuple[Engine, str, str],
) -> None:
    engine, _, agent = world
    assert newest_briefing(engine, agent, CLOCK) == SHOWN
    assert newest_briefing(engine, agent, CLOCK - timedelta(days=30)) is None


def test_earlier_theses_are_the_decided_scans_reasons_newest_first(
    world: tuple[Engine, str, str],
) -> None:
    engine, _, agent = world
    theses = earlier_theses(engine, agent)
    # The failed scan after the clock decided nothing and has no reason to repeat.
    assert theses == ["the trade's reason", "the older reason"]


def test_earlier_theses_are_as_many_as_the_agent_is_shown_as_memory(
    world: tuple[Engine, str, str],
) -> None:
    engine, user, _ = world
    _, busy = find_agent_id(engine, BUSY_AGENT)
    assert earlier_theses(engine, busy) == [f"reason {n}" for n in range(RECENT_SCANS)]
    assert len(recent_scans(engine, user, busy)) == RECENT_SCANS


class _TemplateWorld(World):
    """A world whose database is a small one this test makes, not a restored dump."""

    @property
    def database(self) -> str:
        return TEMPLATE


def test_a_clone_is_its_own_database_and_is_gone_afterwards(database_url: str) -> None:
    server = make_url(database_url).set(database=None).render_as_string(hide_password=False)
    admin = create_engine(
        make_url(database_url).set(drivername="postgresql+psycopg", database="postgres"),
        poolclass=NullPool,
        isolation_level="AUTOCOMMIT",
    )

    def databases() -> set[str]:
        with admin.connect() as connection:
            return set(connection.execute(text("SELECT datname FROM pg_database")).scalars())

    with admin.connect() as connection:
        connection.execute(text(f'DROP DATABASE IF EXISTS "{TEMPLATE}" WITH (FORCE)'))
        connection.execute(text(f'CREATE DATABASE "{TEMPLATE}"'))
    try:
        template = connect(server, TEMPLATE)
        with template.begin() as connection:
            connection.execute(text("CREATE TABLE kept (n int)"))
            connection.execute(text("INSERT INTO kept VALUES (1)"))
        world = _TemplateWorld(id="test", dump="traders-prod-20261119T072136Z")
        with clone(world, server, CLONE) as copy:
            assert CLONE in databases()
            with copy.begin() as connection:
                assert connection.execute(text("SELECT n FROM kept")).scalar_one() == 1
                connection.execute(text("DELETE FROM kept"))
        # What a scan writes stays in its copy, and the copy does not outlive the scan.
        assert CLONE not in databases()
        with template.connect() as connection:
            assert connection.execute(text("SELECT count(*) FROM kept")).scalar_one() == 1
    finally:
        with admin.connect() as connection:
            connection.execute(text(f'DROP DATABASE IF EXISTS "{TEMPLATE}" WITH (FORCE)'))
        admin.dispose()


# -- one sample, end to end ----------------------------------------------------------

SCAN_TEMPLATE = "frozen_world_scan_test_ci"
#: The first answer and the one after the pass is sent back for its idle cash.
ANSWERS = 2
PASS_REASON = "Nothing in the briefing fits the mandate, so the cash stays where it is."


class _ScanWorld(World):
    """A migrated database of this test's own with one agent in it, as a world."""

    @property
    def database(self) -> str:
        return SCAN_TEMPLATE


@pytest.fixture(scope="module")
def scan_world(database_url: str) -> Iterator[tuple[str, Case]]:
    url = make_url(database_url)
    server = url.set(database=None).render_as_string(hide_password=False)
    admin = create_engine(
        url.set(drivername="postgresql+psycopg", database="postgres"),
        poolclass=NullPool,
        isolation_level="AUTOCOMMIT",
    )
    with admin.connect() as connection:
        connection.execute(text(f'DROP DATABASE IF EXISTS "{SCAN_TEMPLATE}" WITH (FORCE)'))
        connection.execute(text(f'CREATE DATABASE "{SCAN_TEMPLATE}"'))
    template_url = url.set(database=SCAN_TEMPLATE).render_as_string(hide_password=False)
    migrated = alembic(template_url, "upgrade", "head")
    assert migrated.returncode == 0, migrated.stderr
    template = connect(server, SCAN_TEMPLATE)
    with template.begin() as connection:
        user = connection.execute(
            text("INSERT INTO users (role, status) VALUES (:role, 'active') RETURNING id::text"),
            {"role": OWNER_ROLE},
        ).scalar_one()
        agent = connection.execute(
            text(
                "INSERT INTO agents (user_id, slug, name, budget_minor) "
                "VALUES (CAST(:u AS uuid), :name, :name, 100000) RETURNING id::text"
            ),
            {"u": user, "name": AGENT},
        ).scalar_one()
        _scan(
            connection,
            user,
            agent,
            CLOCK - timedelta(hours=9),
            briefing=SHOWN,
            answer={"trades": [], "thesis": PASS_REASON},
        )
    world = _ScanWorld(id="test", dump="traders-prod-20261119T072136Z")
    yield server, Case(id="agent-test", world=world, agent=AGENT)
    with admin.connect() as connection:
        connection.execute(text(f'DROP DATABASE IF EXISTS "{SCAN_TEMPLATE}" WITH (FORCE)'))
    admin.dispose()


async def test_a_sample_scans_a_copy_of_the_world_and_leaves_the_world_as_it_was(
    scan_world: tuple[str, Case], monkeypatch: pytest.MonkeyPatch
) -> None:
    server, case = scan_world
    monkeypatch.setattr(
        run_agent_eval,
        "_llm",
        lambda *_args: ScriptedLLM(*[_trades(thesis=PASS_REASON)] * ANSWERS),
    )
    # At once, as `--concurrency 2` runs them: two clones of one template, made together.
    samples = await asyncio.gather(
        *(
            run_agent_eval.run_sample(
                case,
                sample,
                server_url=server,
                closes={},
                settings=Settings(_env_file=None),  # type: ignore[call-arg]
                embedder=HashedEmbedder(),
                model="scripted/model",
                redis=None,  # type: ignore[arg-type] - the scripted model has no spend guard
                cap_usd=Decimal(1),
            )
            for sample in (1, 2)
        )
    )
    for sample in samples:
        assert sample.error is None
        assert sample.readings is not None
        assert sample.readings.outcome == PASS_OUTCOME
        assert sample.readings.passed_without_tools is True
        # The world's last thesis, word for word: the repeat the readings exist to see.
        assert sample.readings.repeated_sentences == [PASS_REASON]
        # All of the agent's cash is idle and the reason quotes none of it, so the pass
        # went back once (D236) and was kept, flagged (D237): the scan's own rules ran.
        assert sample.readings.returned["idle_cash"] == 1
        assert sample.readings.cash_unjustified is True
        assert sample.readings.cost_micro_usd == ANSWERS * STEP_COST
    # The second sample was not told about the first: both were given one briefing.
    assert samples[0].briefing_sha256 == samples[1].briefing_sha256 is not None

    template = connect(server, SCAN_TEMPLATE)
    with template.connect() as connection:
        assert connection.execute(text("SELECT count(*) FROM agent_scans")).scalar_one() == 1
        left = connection.execute(
            text("SELECT count(*) FROM pg_database WHERE datname LIKE 'run\\_agent\\_test%'")
        ).scalar_one()
    assert left == 0


async def test_a_case_whose_agent_is_not_in_the_world_is_recorded_and_not_raised(
    scan_world: tuple[str, Case],
) -> None:
    server, case = scan_world
    sample = await run_agent_eval.run_sample(
        Case(id="nobody-test", world=case.world, agent="nobody by this name"),
        1,
        server_url=server,
        closes={},
        settings=Settings(_env_file=None),  # type: ignore[call-arg]
        embedder=HashedEmbedder(),
        model="scripted/model",
        redis=None,  # type: ignore[arg-type]
        cap_usd=Decimal(1),
    )
    assert sample.readings is None
    assert sample.error is not None and "nobody by this name" in sample.error
