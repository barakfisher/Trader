from datetime import UTC, datetime

import pytest

from app.core.observation_time import observed_at


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
