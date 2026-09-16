"""The loader's contract, without a database.

These tests pin the two things a unit test can honestly check about SQL: which
statement was chosen, and that the values travel as bound parameters and come back
as `PricePoint`s. Whether the SQL is *correct* is an integration question and is
answered against a real table elsewhere - which is precisely why the loader holds
no arithmetic: nothing here needs a database to be verified.
"""

from datetime import UTC, datetime
from types import SimpleNamespace
from uuid import UUID

from app.analysis.price_series import PricePoint
from app.analysis.quote_history import (
    SQL_LATEST_QUOTES,
    SQL_PRICE_SERIES,
    SQL_PRICE_SERIES_UNTIL,
    load_latest_quotes,
    load_price_series,
)

INSTRUMENT = UUID("11111111-1111-1111-1111-111111111111")
OTHER = UUID("22222222-2222-2222-2222-222222222222")
SINCE = datetime(2026, 2, 1, tzinfo=UTC)
UNTIL = datetime(2026, 3, 2, 20, 0, tzinfo=UTC)


class RecordingConnection:
    """Records what was executed and replays canned rows."""

    def __init__(self, rows: list[SimpleNamespace] | None = None) -> None:
        self.rows = rows or []
        self.calls: list[tuple[object, dict]] = []

    def execute(self, statement, parameters):
        self.calls.append((statement, parameters))
        return self.rows


def quote_row(day: int, price_minor: int, currency: str = "USD") -> SimpleNamespace:
    return SimpleNamespace(
        instrument_id=INSTRUMENT,
        as_of=datetime(2026, 3, day, 20, 0, tzinfo=UTC),
        price_minor=price_minor,
        currency=currency,
    )


# -- price series -------------------------------------------------------------


def test_rows_become_price_points():
    connection = RecordingConnection([quote_row(2, 10000), quote_row(3, 10400)])
    series = load_price_series(connection, INSTRUMENT, since=SINCE)
    assert series == [
        PricePoint(datetime(2026, 3, 2, 20, 0, tzinfo=UTC), 10000, "USD"),
        PricePoint(datetime(2026, 3, 3, 20, 0, tzinfo=UTC), 10400, "USD"),
    ]


def test_the_bounds_travel_as_parameters():
    connection = RecordingConnection()
    load_price_series(connection, INSTRUMENT, since=SINCE)
    statement, parameters = connection.calls[0]
    assert statement is SQL_PRICE_SERIES
    assert parameters == {"instrument_id": str(INSTRUMENT), "since": SINCE}


def test_an_upper_bound_selects_the_bounded_statement():
    # A re-run of an earlier bucket must not see prices that did not exist yet, or
    # the same run would produce different findings the second time.
    connection = RecordingConnection()
    load_price_series(connection, INSTRUMENT, since=SINCE, until=UNTIL)
    statement, parameters = connection.calls[0]
    assert statement is SQL_PRICE_SERIES_UNTIL
    assert parameters == {"instrument_id": str(INSTRUMENT), "since": SINCE, "until": UNTIL}


def test_an_instrument_with_no_quotes_yields_an_empty_series():
    assert load_price_series(RecordingConnection(), INSTRUMENT, since=SINCE) == []


def test_the_series_query_is_ordered_by_observation_time():
    assert "ORDER BY as_of" in str(SQL_PRICE_SERIES)
    assert "ORDER BY as_of" in str(SQL_PRICE_SERIES_UNTIL)


# -- latest quotes ------------------------------------------------------------


def test_latest_quotes_are_keyed_by_instrument_id():
    connection = RecordingConnection([quote_row(3, 10400)])
    latest = load_latest_quotes(connection, [INSTRUMENT, OTHER])
    assert latest == {
        str(INSTRUMENT): PricePoint(datetime(2026, 3, 3, 20, 0, tzinfo=UTC), 10400, "USD")
    }
    # The instrument with no row is absent, not present with a zero: an unpriced
    # holding stays recognisable as unpriced.
    assert str(OTHER) not in latest


def test_asking_for_no_instruments_runs_no_query():
    # `IN ()` is a syntax error in Postgres, and a user with no holdings is not an
    # error condition.
    connection = RecordingConnection()
    assert load_latest_quotes(connection, []) == {}
    assert connection.calls == []


def test_the_latest_query_takes_one_row_per_instrument():
    text = str(SQL_LATEST_QUOTES)
    assert "DISTINCT ON (instrument_id)" in text
    assert "ORDER BY instrument_id, as_of DESC" in text
