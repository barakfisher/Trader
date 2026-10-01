from datetime import UTC, datetime

import pytest

from app.core.observation_time import at_last_close, observed_at


def at(hour: int, minute: int, second: int = 0) -> datetime:
    return datetime(2026, 9, 15, hour, minute, second, tzinfo=UTC)


def test_floors_to_the_start_of_the_window():
    assert observed_at(at(14, 7), 900) == at(14, 0)
    assert observed_at(at(14, 14, 59), 900) == at(14, 0)
    assert observed_at(at(14, 15), 900) == at(14, 15)


def test_two_reads_in_one_window_are_the_same_observation():
    # This is the property the (instrument_id, as_of) primary key relies on.
    assert observed_at(at(14, 7), 900) == observed_at(at(14, 12, 30), 900)


def test_reads_in_different_windows_are_distinct_observations():
    assert observed_at(at(14, 7), 900) != observed_at(at(14, 22), 900)


def test_microseconds_never_leak_into_the_key():
    moment = datetime(2026, 9, 15, 14, 7, 33, 987_654, tzinfo=UTC)
    assert observed_at(moment, 900).microsecond == 0
    assert observed_at(moment, 0).microsecond == 0


def test_non_utc_input_is_normalised():
    from zoneinfo import ZoneInfo

    jerusalem = datetime(2026, 9, 15, 17, 7, tzinfo=ZoneInfo("Asia/Jerusalem"))
    assert observed_at(jerusalem, 900) == at(14, 0)


@pytest.mark.parametrize("granularity", [0, -1])
def test_a_continuous_feed_keeps_the_instant(granularity):
    assert observed_at(at(14, 7, 33), granularity) == at(14, 7, 33)


class TestAtLastClose:
    """A listed instrument read outside its session is dated at the close it reports.

    The case that motivated it, from compose: AAPL read on Sunday 27 Sep 2026
    was stored at 21:15 UTC that Sunday, a "close" equal to Friday's.
    """

    SUNDAY = datetime(2026, 9, 27, 21, 15, tzinfo=UTC)
    FRIDAY_US_CLOSE = datetime(2026, 9, 25, 20, 0, tzinfo=UTC)  # 16:00 New York, EDT

    def redate(self, as_of, now, *, symbol="AAPL", asset_class="equity", exchange="NASDAQ"):
        return at_last_close(as_of, now, symbol=symbol, asset_class=asset_class, exchange=exchange)

    def test_a_sunday_read_is_fridays_close(self):
        assert self.redate(self.SUNDAY, self.SUNDAY) == self.FRIDAY_US_CLOSE

    def test_it_meets_the_backfills_close_on_the_primary_key_in_summer(self):
        from app.providers.yfinance_provider import CLOSE_TIME

        assert self.redate(self.SUNDAY, self.SUNDAY).timetz() == CLOSE_TIME

    def test_an_evening_read_is_that_days_close(self):
        tuesday_evening = datetime(2026, 9, 29, 23, 0, tzinfo=UTC)
        assert self.redate(tuesday_evening, tuesday_evening) == datetime(
            2026, 9, 29, 20, 0, tzinfo=UTC
        )

    def test_a_read_during_the_session_is_left_alone(self):
        tuesday_afternoon = datetime(2026, 9, 29, 17, 0, tzinfo=UTC)
        assert self.redate(tuesday_afternoon, tuesday_afternoon) == tuesday_afternoon

    def test_the_close_follows_daylight_saving(self):
        sunday_in_winter = datetime(2026, 12, 6, 12, 0, tzinfo=UTC)
        # 16:00 New York is 21:00 UTC under EST.
        assert self.redate(sunday_in_winter, sunday_in_winter) == datetime(
            2026, 12, 4, 21, 0, tzinfo=UTC
        )

    def test_each_exchange_is_judged_by_its_own_close(self):
        saturday = datetime(2026, 9, 26, 12, 0, tzinfo=UTC)
        # XETRA closes 17:30 in Frankfurt, 15:30 UTC under CEST.
        assert self.redate(saturday, saturday, symbol="SAP.DE", exchange="XETRA") == datetime(
            2026, 9, 25, 15, 30, tzinfo=UTC
        )

    @pytest.mark.parametrize(
        ("symbol", "asset_class", "exchange"),
        [
            ("BTC-USD", "crypto", None),  # continuous: no close to move to
            ("AAPL", "equity", None),  # exchange not known
            ("XYZ", "equity", "OTC"),  # exchange not in the table: not guessed as New York
            ("XYZ", "unknown", "NASDAQ"),  # asset class not known
        ],
    )
    def test_what_cannot_be_judged_is_left_alone(self, symbol, asset_class, exchange):
        assert (
            self.redate(
                self.SUNDAY, self.SUNDAY, symbol=symbol, asset_class=asset_class, exchange=exchange
            )
            == self.SUNDAY
        )

    def test_a_provider_timestamp_at_or_before_the_close_is_kept(self):
        friday_afternoon = datetime(2026, 9, 25, 18, 0, tzinfo=UTC)
        assert self.redate(friday_afternoon, self.SUNDAY) == friday_afternoon
