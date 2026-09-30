"""`quote_history`'s SQL against a real Postgres: fixture rows are skippable.

The exclusion is `NOT (source = ANY(:excluded_sources))`, and the case worth a
real database is the empty list - a demo installation excludes nothing, and an
untyped empty array is exactly what a driver and a planner can disagree about.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import text
from sqlalchemy.engine import Engine

from app.analysis.quote_history import load_price_series

NOW = datetime(2026, 9, 23, 20, 0, tzinfo=UTC)


def _quote(
    connection: object, instrument_id: str, as_of: datetime, minor: int, source: str
) -> None:
    connection.execute(  # type: ignore[attr-defined]
        text(
            """
            INSERT INTO quotes (instrument_id, as_of, price_minor, currency, source)
            VALUES (CAST(:instrument AS uuid), :as_of, :minor, 'USD', :source)
            """
        ),
        {"instrument": instrument_id, "as_of": as_of, "minor": minor, "source": source},
    )


def test_a_real_installation_reads_no_fixture_price(migrated: Engine) -> None:
    with migrated.connect() as connection, connection.begin() as transaction:
        nvda = connection.execute(
            text("INSERT INTO instruments (symbol) VALUES ('NVDA') RETURNING id::text")
        ).scalar_one()
        # The shape of the stored history that produced a false -48.6% drawdown.
        _quote(connection, nvda, NOW - timedelta(days=2), 21829, "yfinance")
        _quote(connection, nvda, NOW - timedelta(days=1), 11845, "fixture")
        _quote(connection, nvda, NOW, 21096, "yfinance")
        since = NOW - timedelta(days=30)

        real = load_price_series(connection, nvda, since=since, excluded_sources=("fixture",))
        demo = load_price_series(connection, nvda, since=since)

        assert [point.price_minor for point in real] == [21829, 21096]
        # A demo installation excludes nothing, and the empty list is valid SQL.
        assert [point.price_minor for point in demo] == [21829, 11845, 21096]
        bounded = load_price_series(
            connection, nvda, since=since, until=NOW, excluded_sources=("fixture",)
        )
        assert [point.price_minor for point in bounded] == [21829, 21096]
        transaction.rollback()
