"""The taxonomy rebuild through the real SQL (D155).

The startup loader fills `universe_taxonomy` from the committed snapshot; the
rest is `rebuild_taxonomy` called directly on that database, because a dropped
member and an unseen category are states a snapshot fixture would take a
rescreen to reach.
"""

from __future__ import annotations

import pytest
from sqlalchemy import text
from sqlalchemy.engine import Engine

from app.universe.taxonomy import ETF_CATEGORY_SECTORS, rebuild_taxonomy
from tests.integration.conftest import run_script

FIXTURE_EMBEDDER = {"EMBEDDINGS_PROVIDER": "fixture"}


@pytest.fixture(scope="module")
def loaded(migrated: Engine, database_url: str) -> Engine:
    result = run_script(database_url, "scripts/ingest_universe.py", "--fixture", **FIXTURE_EMBEDDER)
    assert result.returncode == 0, result.stdout + result.stderr
    return migrated


def _rows(engine: Engine) -> dict[tuple[str, str], tuple[str | None, int, str]]:
    with engine.connect() as connection:
        return {
            (row.kind, row.name): (row.sector, row.instruments, row.version)
            for row in connection.execute(
                text(
                    "SELECT kind, name, sector, instruments, xmin::text AS version "
                    "FROM universe_taxonomy"
                )
            )
        }


def _screened(engine: Engine, column: str) -> int:
    with engine.connect() as connection:
        return connection.execute(
            text(
                f"SELECT count(*) FROM instrument_profiles "  # noqa: S608 - a fixed column name
                f"WHERE membership = 'screened' AND {column} IS NOT NULL"
            )
        ).scalar_one()


def test_the_load_fills_it_from_the_screened_profiles(loaded: Engine) -> None:
    rows = _rows(loaded)
    industries = {key: value for key, value in rows.items() if key[0] == "industry"}
    categories = {key: value for key, value in rows.items() if key[0] == "etf_category"}
    assert industries and categories
    assert sum(count for _, count, _ in industries.values()) == _screened(loaded, "industry")
    assert sum(count for _, count, _ in categories.values()) == _screened(loaded, "category")
    for (_, name), (sector, _, _) in categories.items():
        assert sector == ETF_CATEGORY_SECTORS.get(name)


def test_a_rebuild_that_changes_nothing_writes_nothing(loaded: Engine) -> None:
    before = _rows(loaded)
    with loaded.begin() as connection:
        report = rebuild_taxonomy(connection)
    assert (report.written, report.removed) == (0, 0)
    assert _rows(loaded) == before


def test_a_dropped_member_leaves_the_counts_and_an_emptied_row_goes(loaded: Engine) -> None:
    with loaded.begin() as connection:
        industry, members = connection.execute(
            text(
                "SELECT industry, array_agg(instrument_id) FROM instrument_profiles "
                "WHERE membership = 'screened' AND industry IS NOT NULL "
                "GROUP BY industry ORDER BY count(*), industry LIMIT 1"
            )
        ).one()
        connection.execute(
            text(
                "UPDATE instrument_profiles SET membership = 'dropped' "
                "WHERE instrument_id = ANY(:members)"
            ),
            {"members": members},
        )
        report = rebuild_taxonomy(connection)
        try:
            assert report.removed == 1
            assert ("industry", industry) not in _rows_in(connection)
        finally:
            connection.execute(
                text(
                    "UPDATE instrument_profiles SET membership = 'screened' "
                    "WHERE instrument_id = ANY(:members)"
                ),
                {"members": members},
            )
            rebuild_taxonomy(connection)


def test_an_unseen_category_is_kept_without_a_sector_and_reported(loaded: Engine) -> None:
    with loaded.begin() as connection:
        instrument_id, category = connection.execute(
            text(
                "SELECT instrument_id, category FROM instrument_profiles "
                "WHERE membership = 'screened' AND category IS NOT NULL LIMIT 1"
            )
        ).one()
        connection.execute(
            text(
                "UPDATE instrument_profiles SET category = 'Brand New Category' "
                "WHERE instrument_id = :id"
            ),
            {"id": instrument_id},
        )
        try:
            report = rebuild_taxonomy(connection)
            assert report.unmapped == ["Brand New Category"]
            assert _rows_in(connection)[("etf_category", "Brand New Category")] == (None, 1)
        finally:
            connection.execute(
                text(
                    "UPDATE instrument_profiles SET category = :category WHERE instrument_id = :id"
                ),
                {"id": instrument_id, "category": category},
            )
            rebuild_taxonomy(connection)


def _rows_in(connection) -> dict[tuple[str, str], tuple[str | None, int]]:  # noqa: ANN001
    return {
        (row.kind, row.name): (row.sector, row.instruments)
        for row in connection.execute(
            text("SELECT kind, name, sector, instruments FROM universe_taxonomy")
        )
    }
