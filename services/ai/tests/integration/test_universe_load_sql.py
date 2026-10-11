"""A reload of the snapshot already in the database writes nothing (database sprint DB2).

The startup loader runs on every stack start and loads the newest snapshot even
when it is the one already loaded. Before DB2 that rewrote every profile and
instrument and replaced every ETF holding each time: on the live cluster, 49
loads of 2 distinct snapshots left `instrument_profiles` at 155 MB for 5,243
rows. A row version is what that cost, so a row version is what is checked:
`xmin` is the transaction that wrote the row, and an untouched row keeps it.
"""

from __future__ import annotations

import pytest
from sqlalchemy import text
from sqlalchemy.engine import Engine

from tests.integration.conftest import run_script

FIXTURE_EMBEDDER = {"EMBEDDINGS_PROVIDER": "fixture"}


def _ingest(database_url: str) -> None:
    result = run_script(database_url, "scripts/ingest_universe.py", "--fixture", **FIXTURE_EMBEDDER)
    assert result.returncode == 0, result.stdout + result.stderr


def _row_versions(engine: Engine) -> dict[str, dict[str, str]]:
    """Each table's rows, by a stable key, mapped to the transaction that wrote them."""
    queries = {
        "instruments": "SELECT symbol, xmin::text FROM instruments",
        "instrument_profiles": "SELECT instrument_id::text, xmin::text FROM instrument_profiles",
        "etf_holdings": (
            "SELECT etf_instrument_id::text || ':' || position, xmin::text FROM etf_holdings"
        ),
    }
    with engine.connect() as connection:
        return {
            table: {key: version for key, version in connection.execute(text(sql)).all()}
            for table, sql in queries.items()
        }


def _last_report(engine: Engine) -> dict:
    with engine.connect() as connection:
        return connection.execute(
            text("SELECT report FROM universe_loads ORDER BY loaded_at DESC LIMIT 1")
        ).scalar_one()


@pytest.fixture(scope="module")
def loaded_once(migrated: Engine, database_url: str) -> Engine:
    _ingest(database_url)
    return migrated


def test_the_first_load_writes_and_says_so(loaded_once: Engine) -> None:
    report = _last_report(loaded_once)
    assert report["profiles_written"] == report["profiled"] > 0
    assert report["holdings_replaced"] == 1
    versions = _row_versions(loaded_once)
    assert versions["instrument_profiles"] and versions["etf_holdings"]


def test_a_reload_of_the_same_snapshot_writes_no_row(
    loaded_once: Engine, database_url: str
) -> None:
    before = _row_versions(loaded_once)

    _ingest(database_url)

    assert _row_versions(loaded_once) == before
    report = _last_report(loaded_once)
    assert report["profiles_written"] == 0
    assert report["holdings_replaced"] == 0
    # The reconciliation the admin page reads is unchanged by the skip.
    assert report["profiled"] == len(before["instrument_profiles"])
    assert report["holdings_stored"] == len(before["etf_holdings"])


def test_a_changed_profile_is_still_written(loaded_once: Engine, database_url: str) -> None:
    """The guard skips identical rows only: a row that differs is updated as before."""
    with loaded_once.begin() as connection:
        symbol = connection.execute(
            text(
                "UPDATE instrument_profiles SET sector = 'Edited by the test' "
                "WHERE instrument_id = (SELECT instrument_id FROM instrument_profiles "
                "WHERE description IS NOT NULL ORDER BY instrument_id LIMIT 1) "
                "RETURNING (SELECT symbol FROM instruments WHERE id = instrument_id)"
            )
        ).scalar_one()

    _ingest(database_url)

    with loaded_once.connect() as connection:
        sector = connection.execute(
            text(
                "SELECT p.sector FROM instrument_profiles p "
                "JOIN instruments i ON i.id = p.instrument_id WHERE i.symbol = :symbol"
            ),
            {"symbol": symbol},
        ).scalar_one()
    assert sector != "Edited by the test"
    assert _last_report(loaded_once)["profiles_written"] == 1
