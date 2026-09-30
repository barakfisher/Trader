"""History: the half of the provider contract that was specified and never built.

`MarketDataProvider.history` has been in DESIGN.md section 4 since the first
commit. It was dropped when Milestone 1 was decomposed into tasks, and nobody
noticed for two milestones because M1's exit criterion - upload a CSV, see a
valued portfolio - needs current prices and nothing else. The analysis engine has
therefore only ever run on a synthetic fixture.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from app.models import BackfillInstrument
from app.providers.base import ProviderError


class StubConnection:
    """Captures the rows a backfill would write."""

    def __init__(self, already_present: int = 0) -> None:
        self.rows: list[dict] = []
        self._already_present = already_present

    def execute(self, _statement, rows):
        self.rows.extend(rows)
        written = max(len(rows) - self._already_present, 0)
        return type("Result", (), {"rowcount": written})


async def test_fixture_history_is_served_from_the_committed_series(fixture_provider):
    closes = await fixture_provider.history("NVDA", 120)
    assert len(closes) > 30
    assert [close.as_of for close in closes] == sorted(close.as_of for close in closes)
    assert all(close.currency == "USD" for close in closes)
    assert all(close.price_minor > 0 for close in closes)


async def test_fixture_history_ends_before_today(fixture_provider):
    # The series is shifted at load time so it stays current; a fixture with
    # hardcoded dates rots, and the rules would analyse a stale window.
    closes = await fixture_provider.history("NVDA", 120)
    assert closes[-1].as_of.date() < datetime.now(UTC).date()


async def test_a_shorter_window_returns_fewer_days(fixture_provider):
    long_window = await fixture_provider.history("NVDA", 120)
    short_window = await fixture_provider.history("NVDA", 10)
    assert 0 < len(short_window) < len(long_window)


async def test_an_unknown_symbol_has_no_history_and_is_not_an_error(fixture_provider):
    assert await fixture_provider.history("NOSUCHSYM", 120) == []


class TestChain:
    async def test_the_first_provider_with_a_series_wins(self, market_data, fixture_provider):
        closes = await market_data.history("NVDA", 120)
        assert closes and closes[0].source == "fixture"

    async def test_a_series_is_never_stitched_from_two_providers(self, settings, fixture_provider):
        # Mixing providers in one series would mean a daily return measured
        # across the seam compares two definitions of a close, not a move.
        from app.core.cache import Cache
        from app.core.ratelimit import RateLimiter
        from app.providers.registry import MarketDataService
        from tests.fakes import FakeRedis

        class EmptyProvider:
            name = "empty"
            delay_seconds = 0
            quote_granularity_seconds = 0
            makes_external_requests = False
            batches_requests = True

            async def quotes(self, symbols):
                return []

            async def resolve(self, query):
                raise ProviderError(self.name, "no")

            async def fx_rate(self, base, quote):
                return None

            async def history(self, symbol, days):
                return []

        redis = FakeRedis()
        service = MarketDataService(
            [EmptyProvider(), fixture_provider], Cache(redis), RateLimiter(redis), settings
        )
        closes = await service.history("NVDA", 120)
        assert {close.source for close in closes} == {"fixture"}

    async def test_the_second_call_is_cached(self, market_data, fixture_provider, monkeypatch):
        await market_data.history("NVDA", 120)

        async def explode(_symbol, _days):
            raise AssertionError("history must not be refetched within its TTL")

        monkeypatch.setattr(fixture_provider, "history", explode)
        assert await market_data.history("NVDA", 120)


class TestBackfill:
    async def test_writes_a_series_per_instrument(self, market_data):
        from app.analysis.backfill import backfill_history

        connection = StubConnection()
        response = await backfill_history(
            connection,
            market_data,
            [BackfillInstrument(instrument_id="i1", symbol="NVDA")],
            days=120,
        )
        assert response.written == len(connection.rows) > 0
        assert response.per_symbol["NVDA"] == response.written
        assert response.without_history == []

    async def test_reports_a_symbol_it_could_not_fill(self, market_data):
        # A holding the engine cannot analyse is something the user should be
        # able to discover, so it is reported rather than omitted.
        from app.analysis.backfill import backfill_history

        response = await backfill_history(
            StubConnection(),
            market_data,
            [BackfillInstrument(instrument_id="i9", symbol="NOSUCHSYM")],
            days=120,
        )
        assert response.without_history == ["NOSUCHSYM"]
        assert response.written == 0

    async def test_a_repeat_writes_nothing(self, market_data):
        from app.analysis.backfill import backfill_history

        first = StubConnection()
        await backfill_history(
            first, market_data, [BackfillInstrument(instrument_id="i1", symbol="NVDA")], days=120
        )
        # Every row already present: the table's primary key rejects them all.
        repeat = StubConnection(already_present=len(first.rows))
        response = await backfill_history(
            repeat, market_data, [BackfillInstrument(instrument_id="i1", symbol="NVDA")], days=120
        )
        assert response.written == 0
        assert response.already_present == len(first.rows)

    async def test_a_day_still_trading_is_not_stored(self, market_data):
        # A provider returns today's candle during the session, dated to 20:00
        # UTC. Stored at 06:45 UTC it was a price observed in the future, and
        # the price at run time became the day's close.
        from app.analysis.backfill import backfill_history

        full = StubConnection()
        await backfill_history(
            full, market_data, [BackfillInstrument(instrument_id="i1", symbol="NVDA")], days=120
        )
        last_close = max(row["as_of"] for row in full.rows)
        before_it_closed = last_close - timedelta(hours=13)

        early = StubConnection()
        response = await backfill_history(
            early,
            market_data,
            [BackfillInstrument(instrument_id="i1", symbol="NVDA")],
            days=120,
            now=before_it_closed,
        )
        assert all(row["as_of"] <= before_it_closed for row in early.rows)
        assert response.not_final == 1
        assert len(early.rows) == len(full.rows) - 1


@pytest.mark.parametrize("days", [2, 3650])
async def test_window_bounds_are_accepted(fixture_provider, days):
    assert isinstance(await fixture_provider.history("NVDA", days), list)


async def test_prices_are_integer_minor_units(fixture_provider):
    closes = await fixture_provider.history("NVDA", 30)
    assert all(isinstance(close.price_minor, int) for close in closes)
    # A close of 129.45 is 12945, never a float that drifts.
    assert all(Decimal(close.price_minor) == close.price_minor for close in closes)


async def test_history_dates_do_not_collide_with_intraday_quotes(fixture_provider):
    closes = await fixture_provider.history("NVDA", 30)
    gaps = {
        (b.as_of - a.as_of)
        for a, b in zip(closes, closes[1:])  # noqa: B905 - deliberately ragged
    }
    assert all(gap >= timedelta(days=1) for gap in gaps)
