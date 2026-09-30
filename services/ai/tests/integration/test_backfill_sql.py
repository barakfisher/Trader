"""The backfill's upsert against a real Postgres: what it corrects, and what it never touches.

A close stored while its day was still trading has to be corrected by a later
run, and the rule that allows that must not reach anything else sharing the
same `(instrument_id, as_of)`: a live quote observed at 20:00, or a row from a
different source. `ON CONFLICT ... WHERE` is exactly the kind of clause a stub
connection cannot check.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import text
from sqlalchemy.engine import Engine

from app.analysis.backfill import backfill_history
from app.models import BackfillInstrument, DailyClose

CLOSE = datetime(2026, 9, 16, 20, 0, tzinfo=UTC)


class ScriptedMarket:
    """Answers `history` with a fixed series, as the provider chain would."""

    def __init__(self, closes: list[DailyClose]) -> None:
        self.closes = closes

    async def history(self, _symbol: str, _days: int) -> list[DailyClose]:
        return self.closes


def _close(as_of: datetime, minor: int, source: str = "yfinance") -> DailyClose:
    return DailyClose(symbol="AAPL", as_of=as_of, price_minor=minor, currency="USD", source=source)


def _stored(connection: object, instrument_id: str) -> list[tuple[datetime, int, str, int]]:
    rows = connection.execute(  # type: ignore[attr-defined]
        text(
            "SELECT as_of, price_minor, source, delay_seconds FROM quotes "
            "WHERE instrument_id = CAST(:id AS uuid) ORDER BY as_of, source"
        ),
        {"id": instrument_id},
    )
    return [(row.as_of, row.price_minor, row.source, row.delay_seconds) for row in rows]


async def test_a_later_run_corrects_a_close_stored_mid_session(migrated: Engine) -> None:
    with migrated.connect() as connection, connection.begin() as transaction:
        aapl = connection.execute(
            text("INSERT INTO instruments (symbol) VALUES ('AAPL') RETURNING id::text")
        ).scalar_one()
        instruments = [BackfillInstrument(instrument_id=aapl, symbol="AAPL")]

        # 16:41 UTC on 16 Sep: the day's candle is priced at the latest trade.
        # (`now` is after the stamp, as a crypto day stamped 20:00 is at 22:00.)
        mid = await backfill_history(
            connection,
            ScriptedMarket([_close(CLOSE, 33257)]),
            instruments,
            30,
            now=CLOSE + timedelta(hours=2),
        )
        assert mid.written == 1

        # The next run sees the finished day.
        final = await backfill_history(
            connection,
            ScriptedMarket([_close(CLOSE, 33241)]),
            instruments,
            30,
            now=CLOSE + timedelta(days=1),
        )
        assert final.written == 1
        assert _stored(connection, aapl) == [(CLOSE, 33241, "yfinance", 0)]

        # Unchanged since: nothing is written.
        again = await backfill_history(
            connection,
            ScriptedMarket([_close(CLOSE, 33241)]),
            instruments,
            30,
            now=CLOSE + timedelta(days=2),
        )
        assert (again.written, again.already_present) == (0, 1)
        transaction.rollback()


async def test_an_observation_or_another_source_is_never_rewritten(migrated: Engine) -> None:
    with migrated.connect() as connection, connection.begin() as transaction:
        aapl = connection.execute(
            text("INSERT INTO instruments (symbol) VALUES ('AAPL') RETURNING id::text")
        ).scalar_one()
        day_before = CLOSE - timedelta(days=1)
        connection.execute(
            text(
                """
                INSERT INTO quotes (instrument_id, as_of, price_minor, currency, source,
                                    delay_seconds)
                VALUES (CAST(:id AS uuid), :live, 33300, 'USD', 'yfinance', 900),
                       (CAST(:id AS uuid), :fixture, 11845, 'USD', 'fixture', 0)
                """
            ),
            {"id": aapl, "live": CLOSE, "fixture": day_before},
        )

        response = await backfill_history(
            connection,
            ScriptedMarket([_close(day_before, 33100), _close(CLOSE, 33241)]),
            [BackfillInstrument(instrument_id=aapl, symbol="AAPL")],
            30,
            now=CLOSE + timedelta(days=1),
        )

        assert response.written == 0
        assert _stored(connection, aapl) == [
            (day_before, 11845, "fixture", 0),
            (CLOSE, 33300, "yfinance", 900),
        ]
        transaction.rollback()
