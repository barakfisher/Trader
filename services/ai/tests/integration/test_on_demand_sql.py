"""On-demand profiles through the real SQL: described, never a member, never a
topic's answer, never a screened profile overwritten - and promoted the moment
a snapshot admits the listing (decision 89)."""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime
from unittest.mock import patch

import pytest
from sqlalchemy import text
from sqlalchemy.engine import Engine

from app.corpus.hashed_embedder import HashedEmbedder
from app.universe.membership import DatabaseMembership
from app.universe.profiles import (
    coverage,
    embed_profile,
    insert_on_demand,
    profile_exists,
    search_profiles,
)
from app.universe.snapshot import UniverseInstrument
from tests.integration.conftest import run_script

FIXTURE_EMBEDDER = {"EMBEDDINGS_PROVIDER": "fixture"}

#: Worded to be the nearest profile to "uranium mining" if anything let it be found.
TINY = UniverseInstrument(
    symbol="TINYU",
    name="Tiny Uranium Mining Corp",
    asset_class="equity",
    exchange="NMS",
    currency="USD",
    market_cap_minor=5_000_000_000,
    net_assets_minor=None,
    sector="Energy",
    industry="Uranium",
    category=None,
    description="Uranium mining. Uranium mining in uranium mines, mining uranium.",
)


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


@pytest.fixture(scope="module")
def loaded(migrated: Engine, database_url: str) -> Engine:
    _load(database_url)
    return migrated


async def test_an_on_demand_profile_is_described_but_answers_no_topic(loaded: Engine) -> None:
    embedder = HashedEmbedder()
    with loaded.begin() as connection:
        before = coverage(connection, model=embedder.model)
        instrument_id = insert_on_demand(
            connection, TINY, source="test", license="test", as_of=datetime.now(UTC)
        )
        assert instrument_id is not None
        assert await embed_profile(connection, instrument_id, embedder)
        # Embedded once: a second call finds nothing to do.
        assert not await embed_profile(connection, instrument_id, embedder)

    assert _membership(loaded, "TINYU") == "on_demand"
    with loaded.connect() as connection:
        assert profile_exists(connection, "TINYU")
        matches = search_profiles(
            connection,
            embedding=await embedder.embed_query("uranium mining"),
            model=embedder.model,
            limit=50,
        )
        after = coverage(connection, model=embedder.model)
    assert "TINYU" not in {match.symbol for match in matches}
    assert after == before

    with patch("app.universe.membership.get_engine", return_value=loaded):
        # Still a gap: only a rescreen can close it.
        assert DatabaseMembership().contains("TINYU") is False


def test_a_fetch_never_downgrades_a_screened_profile(loaded: Engine) -> None:
    member = replace(TINY, symbol="CCJ", description="rewritten")
    with loaded.begin() as connection:
        before = connection.execute(
            text(
                "SELECT p.description FROM instrument_profiles p "
                "JOIN instruments i ON i.id = p.instrument_id WHERE i.symbol = 'CCJ'"
            )
        ).scalar_one()
        assert (
            insert_on_demand(
                connection, member, source="test", license="test", as_of=datetime.now(UTC)
            )
            is None
        )
    assert _membership(loaded, "CCJ") == "screened"
    with loaded.connect() as connection:
        after = connection.execute(
            text(
                "SELECT p.description FROM instrument_profiles p "
                "JOIN instruments i ON i.id = p.instrument_id WHERE i.symbol = 'CCJ'"
            )
        ).scalar_one()
    assert after == before


def test_a_snapshot_that_admits_the_listing_promotes_it(loaded: Engine, database_url: str) -> None:
    with loaded.begin() as connection:
        connection.execute(
            text(
                "UPDATE instrument_profiles SET membership = 'on_demand' WHERE instrument_id = "
                "(SELECT id FROM instruments WHERE symbol = 'NXE')"
            )
        )
    assert _membership(loaded, "NXE") == "on_demand"
    _load(database_url)
    assert _membership(loaded, "NXE") == "screened"
    # And an on-demand profile the snapshot does not hold is left as it was.
    assert _membership(loaded, "TINYU") == "on_demand"
