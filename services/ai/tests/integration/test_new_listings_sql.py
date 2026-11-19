"""The daily new-listings screen through the real SQL.

A listing the screen admits between rescreens is `listed`: a member, found by a
topic and tradable from the next scan, and left alone by the startup loader,
which reloads a snapshot older than it on every deploy. Yahoo is the one thing
replaced - the screen's rows are passed in and the profile source is a fake.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import patch

import pytest
from sqlalchemy import text
from sqlalchemy.engine import Engine

from app.agents.tools import find_listing
from app.corpus.hashed_embedder import HashedEmbedder
from app.universe.membership import DatabaseMembership
from app.universe.new_listings import (
    MAX_ADMITTED_PER_RUN,
    PROFILE_BUDGET_SECONDS,
    admit_new_listings,
)
from app.universe.profile_source import ProfileSourceError
from app.universe.profiles import insert_on_demand, mark_dropped, search_profiles
from app.universe.snapshot import UniverseInstrument
from tests.integration.conftest import run_script

FIXTURE_EMBEDDER = {"EMBEDDINGS_PROVIDER": "fixture"}

#: Worded to be the nearest profile to "artificial intelligence models".
NEW_AI = UniverseInstrument(
    symbol="NEWAI",
    name="New AI Models, PBC",
    asset_class="equity",
    exchange="NMS",
    currency="USD",
    market_cap_minor=500_000_000_000_00,
    net_assets_minor=None,
    sector="Technology",
    industry="Software - Infrastructure",
    category=None,
    description=(
        "Builds artificial intelligence models. Artificial intelligence models and AI "
        "assistants for businesses, trained artificial intelligence models."
    ),
)


def quote(symbol: str, market_cap: int, name: str | None = None) -> dict[str, Any]:
    """One screener row, as `screen_market` returns it."""
    return {
        "symbol": symbol,
        "longName": name or f"{symbol} Inc.",
        "quoteType": "EQUITY",
        "exchange": "NMS",
        "marketCap": market_cap,
        "averageDailyVolume3Month": 1_000_000,
    }


class FakeSource:
    source = "test-source"
    license = "test-license"

    def __init__(self, members: dict[str, UniverseInstrument | None | Exception]) -> None:
        self.members = members
        self.asked: list[str] = []

    async def profile(self, symbol: str) -> UniverseInstrument | None:
        self.asked.append(symbol)
        answer = self.members.get(symbol)
        if isinstance(answer, Exception):
            raise answer
        return answer


def _load(database_url: str) -> None:
    result = run_script(database_url, "scripts/ingest_universe.py", "--fixture", **FIXTURE_EMBEDDER)
    assert result.returncode == 0, result.stdout + result.stderr


def _membership(engine: Engine, symbol: str) -> str | None:
    with engine.connect() as connection:
        return connection.execute(
            text(
                "SELECT p.membership FROM instrument_profiles p "
                "JOIN instruments i ON i.id = p.instrument_id WHERE i.symbol = :symbol"
            ),
            {"symbol": symbol},
        ).scalar_one_or_none()


def _profile_count(engine: Engine) -> int:
    with engine.connect() as connection:
        count = connection.execute(text("SELECT count(*) FROM instrument_profiles"))
        return int(count.scalar_one())


@pytest.fixture
def loaded(migrated: Engine, database_url: str) -> Engine:
    """A fresh fixture universe per test: each admits listings of its own."""
    with migrated.begin() as connection:
        connection.execute(text("TRUNCATE instrument_profiles, etf_holdings CASCADE"))
    _load(database_url)
    return migrated


async def test_a_new_listing_is_a_member_found_by_a_topic_and_tradable(loaded: Engine) -> None:
    embedder = HashedEmbedder()
    source = FakeSource({"NEWAI": NEW_AI})

    report = await admit_new_listings(
        engine=loaded,
        embedder=embedder,
        source=source,
        quotes=[quote("CCJ", 20_000_000_000), quote("NEWAI", 500_000_000_000)],
        now=datetime.now(UTC),
    )

    assert report.admitted == ["NEWAI"]
    # A symbol already screened is never asked about.
    assert source.asked == ["NEWAI"]
    assert _membership(loaded, "NEWAI") == "listed"
    with loaded.connect() as connection:
        matches = search_profiles(
            connection,
            embedding=await embedder.embed_query("artificial intelligence models"),
            model=embedder.model,
            limit=5,
        )
    assert matches[0].symbol == "NEWAI"
    with patch("app.universe.membership.get_engine", return_value=loaded):
        assert DatabaseMembership().contains("NEWAI") is True
    listing = find_listing(loaded, "NEWAI")
    assert listing is not None and listing.tradable


async def test_a_second_run_finds_nothing_new_and_writes_nothing(loaded: Engine) -> None:
    quotes = [quote("NEWAI", 500_000_000_000)]
    source = FakeSource({"NEWAI": NEW_AI})
    await admit_new_listings(
        engine=loaded,
        embedder=HashedEmbedder(),
        source=source,
        quotes=quotes,
        now=datetime.now(UTC),
    )
    before = _profile_count(loaded)

    again = await admit_new_listings(
        engine=loaded,
        embedder=HashedEmbedder(),
        source=source,
        quotes=quotes,
        now=datetime.now(UTC),
    )

    assert again.candidates == 0
    assert again.admitted == []
    assert source.asked == ["NEWAI"]
    assert _profile_count(loaded) == before


async def test_a_listing_yahoo_has_not_described_yet_waits_for_a_later_run(
    loaded: Engine,
) -> None:
    """Listing day: Yahoo knows the name but has no description or currency yet."""
    quotes = [quote("NEWAI", 500_000_000_000)]
    first = await admit_new_listings(
        engine=loaded,
        embedder=HashedEmbedder(),
        source=FakeSource({"NEWAI": replace(NEW_AI, description=None)}),
        quotes=quotes,
        now=datetime.now(UTC),
    )
    no_currency = await admit_new_listings(
        engine=loaded,
        embedder=HashedEmbedder(),
        source=FakeSource({"NEWAI": replace(NEW_AI, currency=None)}),
        quotes=quotes,
        now=datetime.now(UTC),
    )
    assert first.no_description == ["NEWAI"]
    assert no_currency.no_currency == ["NEWAI"]
    assert _membership(loaded, "NEWAI") is None

    later = await admit_new_listings(
        engine=loaded,
        embedder=HashedEmbedder(),
        source=FakeSource({"NEWAI": NEW_AI}),
        quotes=quotes,
        now=datetime.now(UTC),
    )
    assert later.admitted == ["NEWAI"]


async def test_a_source_failure_is_reported_and_writes_nothing(loaded: Engine) -> None:
    report = await admit_new_listings(
        engine=loaded,
        embedder=HashedEmbedder(),
        source=FakeSource({"NEWAI": ProfileSourceError("rate limited")}),
        quotes=[quote("NEWAI", 500_000_000_000)],
        now=datetime.now(UTC),
    )
    assert report.failed == ["NEWAI"]
    assert report.admitted == []
    assert _membership(loaded, "NEWAI") is None


async def test_one_run_admits_at_most_its_cap_largest_first(loaded: Engine) -> None:
    count = MAX_ADMITTED_PER_RUN + 3
    quotes = [quote(f"NEW{n:03d}", 2_000_000_000 + n) for n in range(count)]
    members = {
        str(q["symbol"]): replace(NEW_AI, symbol=str(q["symbol"]), name=str(q["longName"]))
        for q in quotes
    }

    report = await admit_new_listings(
        engine=loaded,
        embedder=HashedEmbedder(),
        source=FakeSource(members),
        quotes=quotes,
        now=datetime.now(UTC),
    )

    assert len(report.admitted) == MAX_ADMITTED_PER_RUN
    assert report.deferred == 3
    # The three left for the next run are the smallest.
    assert _membership(loaded, "NEW000") is None
    assert _membership(loaded, f"NEW{count - 1:03d}") == "listed"


async def test_an_on_demand_profile_the_screen_now_admits_becomes_listed(loaded: Engine) -> None:
    with loaded.begin() as connection:
        insert_on_demand(connection, NEW_AI, source="test", license="test", as_of=datetime.now(UTC))
    assert _membership(loaded, "NEWAI") == "on_demand"

    report = await admit_new_listings(
        engine=loaded,
        embedder=HashedEmbedder(),
        source=FakeSource({"NEWAI": NEW_AI}),
        quotes=[quote("NEWAI", 500_000_000_000)],
        now=datetime.now(UTC),
    )

    assert report.admitted == ["NEWAI"]
    assert _membership(loaded, "NEWAI") == "listed"


async def test_the_startup_loader_keeps_a_listing_newer_than_its_snapshot(
    loaded: Engine, database_url: str
) -> None:
    """Every deploy reloads the committed snapshot; a listing since then must survive it."""
    await admit_new_listings(
        engine=loaded,
        embedder=HashedEmbedder(),
        source=FakeSource({"NEWAI": NEW_AI}),
        quotes=[quote("NEWAI", 500_000_000_000)],
        now=datetime.now(UTC),
    )

    _load(database_url)

    assert _membership(loaded, "NEWAI") == "listed"


async def test_a_later_snapshot_without_the_listing_drops_it(loaded: Engine) -> None:
    listed_at = datetime.now(UTC)
    await admit_new_listings(
        engine=loaded,
        embedder=HashedEmbedder(),
        source=FakeSource({"NEWAI": NEW_AI}),
        quotes=[quote("NEWAI", 500_000_000_000)],
        now=listed_at,
    )
    # A snapshot taken before the listing cannot judge it ...
    with loaded.begin() as connection:
        mark_dropped(connection, {"CCJ"}, as_of=listed_at - timedelta(days=1))
    assert _membership(loaded, "NEWAI") == "listed"
    # ... one taken after it, which no longer holds it, can.
    with loaded.begin() as connection:
        mark_dropped(connection, {"CCJ"}, as_of=listed_at + timedelta(days=1))
    assert _membership(loaded, "NEWAI") == "dropped"


async def test_a_later_snapshot_that_holds_the_listing_makes_it_screened(
    loaded: Engine, database_url: str
) -> None:
    """The committed snapshot holds CCJ; a CCJ listed by the daily screen is promoted by it."""
    with loaded.begin() as connection:
        connection.execute(
            text(
                "UPDATE instrument_profiles SET membership = 'listed' WHERE instrument_id = "
                "(SELECT id FROM instruments WHERE symbol = 'CCJ')"
            )
        )
    _load(database_url)
    assert _membership(loaded, "CCJ") == "screened"


#: A member of the committed snapshot that Yahoo never described (its manifest's
#: `without_description`): turned away every day, so it must never crowd out a listing.
UNDESCRIBED_MEMBER = "AAAC"


class FailingEmbedder(HashedEmbedder):
    async def embed_documents(self, texts: list[str]) -> Any:
        raise RuntimeError("embedding provider down")


async def test_a_snapshot_member_yahoo_never_described_is_asked_about_last(loaded: Engine) -> None:
    quotes = [quote(f"NEW{n:03d}", 2_000_000_000 + n) for n in range(MAX_ADMITTED_PER_RUN)]
    # The largest row of all, yet it must not take a place in the cap.
    quotes.append(quote(UNDESCRIBED_MEMBER, 900_000_000_000))
    members = {
        str(q["symbol"]): replace(NEW_AI, symbol=str(q["symbol"]), name=str(q["longName"]))
        for q in quotes
    }
    source = FakeSource(members)

    report = await admit_new_listings(
        engine=loaded,
        embedder=HashedEmbedder(),
        source=source,
        quotes=quotes,
        now=datetime.now(UTC),
    )

    assert UNDESCRIBED_MEMBER not in source.asked
    assert report.deferred == 1
    assert len(report.admitted) == MAX_ADMITTED_PER_RUN


async def test_another_share_class_of_a_member_company_is_not_admitted(loaded: Engine) -> None:
    with loaded.connect() as connection:
        company = connection.execute(
            text("SELECT name FROM instruments WHERE symbol = 'CCJ'")
        ).scalar_one()
    source = FakeSource({"CCJB": replace(NEW_AI, symbol="CCJB", name=company)})

    report = await admit_new_listings(
        engine=loaded,
        embedder=HashedEmbedder(),
        source=source,
        quotes=[quote("CCJB", 20_000_000_000, name=company)],
        now=datetime.now(UTC),
    )

    assert report.same_company == 1
    assert report.candidates == 0
    assert source.asked == []
    assert _membership(loaded, "CCJB") is None


async def test_what_is_not_asked_within_the_budget_waits_for_the_next_run(loaded: Engine) -> None:
    quotes = [quote("NEWAI", 500_000_000_000), quote("LATER", 400_000_000_000)]
    ticks = iter([0.0, 0.0, PROFILE_BUDGET_SECONDS + 1])
    source = FakeSource({"NEWAI": NEW_AI, "LATER": replace(NEW_AI, symbol="LATER")})

    report = await admit_new_listings(
        engine=loaded,
        embedder=HashedEmbedder(),
        source=source,
        quotes=quotes,
        now=datetime.now(UTC),
        clock=lambda: next(ticks, PROFILE_BUDGET_SECONDS + 1),
    )

    assert report.admitted == ["NEWAI"]
    assert source.asked == ["NEWAI"]
    assert report.deferred == 1


async def test_a_failed_embedding_is_reported_and_the_next_run_embeds_it(loaded: Engine) -> None:
    quotes = [quote("NEWAI", 500_000_000_000)]
    failed = await admit_new_listings(
        engine=loaded,
        embedder=FailingEmbedder(),
        source=FakeSource({"NEWAI": NEW_AI}),
        quotes=quotes,
        now=datetime.now(UTC),
    )
    assert failed.admitted == ["NEWAI"]
    assert failed.unembedded == ["NEWAI"]

    await admit_new_listings(
        engine=loaded,
        embedder=HashedEmbedder(),
        source=FakeSource({}),
        quotes=quotes,
        now=datetime.now(UTC),
    )
    with loaded.connect() as connection:
        model = connection.execute(
            text(
                "SELECT p.embedding_model FROM instrument_profiles p "
                "JOIN instruments i ON i.id = p.instrument_id WHERE i.symbol = 'NEWAI'"
            )
        ).scalar_one()
    assert model == HashedEmbedder().model
