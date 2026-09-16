"""The shared arithmetic: normalisation, steps, windows, deviation.

Every rule reads its numbers through this module, so a defect here is a defect in
all four rules at once. The series are written out literally so a failure names a
specific price.
"""

import math
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from app.analysis.price_series import (
    PricePoint,
    normalise,
    sample_stdev,
    steps,
    trailing_high,
    window,
)

#: 2026-03-02 is a Monday; 20:00 UTC is after the US close, which is where a
#: daily close observation lands.
MONDAY_CLOSE = datetime(2026, 3, 2, 20, 0, tzinfo=UTC)


def at(day_offset: float, price_minor: int, currency: str = "USD") -> PricePoint:
    return PricePoint(MONDAY_CLOSE + timedelta(days=day_offset), price_minor, currency)


# -- normalise ----------------------------------------------------------------


def test_points_are_sorted_ascending():
    series = normalise([at(2, 10200), at(0, 10000), at(1, 10100)])
    assert [point.price_minor for point in series] == [10000, 10100, 10200]


def test_a_repeated_observation_time_keeps_the_later_value():
    # `as_of` is floored to the provider's window, so a caller merging a fresh
    # quote into a loaded series produces two rows for one observation. The fresh
    # value - last in input order - is the corrected one.
    series = normalise([at(0, 10000), at(0, 10007)])
    assert [point.price_minor for point in series] == [10007]


def test_non_positive_prices_are_dropped_rather_than_used():
    # A zero price is a provider defect. Keeping it would produce a -100% move
    # and, as a denominator, a division by zero.
    series = normalise([at(0, 10000), at(1, 0), at(2, -500), at(3, 10100)])
    assert [point.price_minor for point in series] == [10000, 10100]


def test_naive_timestamps_are_read_as_utc():
    series = normalise([PricePoint(datetime(2026, 3, 2, 20, 0), 10000, "USD")])
    assert series[0].as_of == MONDAY_CLOSE


def test_offset_timestamps_are_converted_not_truncated():
    # 22:00 in Jerusalem is 20:00 UTC: the same instant, which must not sort as a
    # different observation.
    jerusalem = PricePoint(
        datetime(2026, 3, 2, 22, 0, tzinfo=ZoneInfo("Asia/Jerusalem")), 10000, "USD"
    )
    assert normalise([jerusalem])[0].as_of == MONDAY_CLOSE


def test_an_empty_series_normalises_to_an_empty_series():
    assert normalise([]) == []


# -- steps --------------------------------------------------------------------


def test_a_step_is_the_ratio_between_consecutive_prices():
    (step,) = steps(normalise([at(0, 10000), at(1, 10400)]))
    assert step.return_ratio == 0.04
    assert step.gap_days == 1.0


def test_one_point_yields_no_step():
    assert steps(normalise([at(0, 10000)])) == []


def test_a_weekend_is_measured_not_hidden():
    # Friday to Monday is three calendar days and an entirely ordinary step.
    (step,) = steps(normalise([at(0, 10000), at(3, 10100)]))
    assert step.gap_days == 3.0
    assert step.within_gap(5) is True


def test_a_long_outage_is_reported_as_out_of_gap():
    (step,) = steps(normalise([at(0, 10000), at(21, 10100)]))
    assert step.gap_days == 21.0
    assert step.within_gap(5) is False


def test_a_change_of_currency_is_not_a_return():
    # A EUR price over a USD price is an FX rate times a return. Skipping the pair
    # is the only honest option here.
    series = normalise([at(0, 10000, "USD"), at(1, 9100, "EUR"), at(2, 9200, "EUR")])
    assert [step.return_ratio for step in steps(series)] == [(9200 - 9100) / 9100]


# -- window and trailing high -------------------------------------------------


def test_the_window_is_anchored_on_the_last_observation_not_on_now():
    series = normalise([at(0, 10000), at(10, 10100), at(20, 10200)])
    assert [point.price_minor for point in window(series, days=11)] == [10100, 10200]


def test_the_window_edge_is_inclusive():
    series = normalise([at(0, 10000), at(5, 10500)])
    assert len(window(series, days=5)) == 2


def test_the_trailing_high_is_the_highest_price():
    series = normalise([at(0, 10000), at(1, 11000), at(2, 10500)])
    high = trailing_high(series)
    assert high is not None
    assert high.price_minor == 11000
    assert high.as_of == MONDAY_CLOSE + timedelta(days=1)


def test_a_tied_high_reports_the_first_time_the_level_was_reached():
    series = normalise([at(0, 11000), at(1, 10500), at(2, 11000)])
    high = trailing_high(series)
    assert high is not None
    assert high.as_of == MONDAY_CLOSE


def test_no_points_no_high():
    assert trailing_high([]) is None


# -- deviation ----------------------------------------------------------------


def test_the_deviation_is_bessel_corrected():
    # Returns 0.01 and 0.03: mean 0.02, deviations +/-0.01, so the n-1 form is
    # sqrt(2 * 0.0001 / 1) = 0.01414..., where the n form would give 0.01.
    assert sample_stdev([0.01, 0.03]) == math.sqrt(0.0002)


def test_a_single_return_has_no_deviation():
    assert sample_stdev([0.01]) is None
    assert sample_stdev([]) is None


def test_a_flat_series_has_zero_deviation():
    # Zero rather than None: the sample is large enough, it simply never moved.
    # The sigma rule turns this into "no finding" rather than a division.
    assert sample_stdev([0.0, 0.0, 0.0]) == 0.0


def test_the_mean_is_not_assumed_to_be_zero():
    # A steadily trending instrument has no volatility by this measure, and that
    # is the point: the trend is not a shock.
    assert sample_stdev([0.02, 0.02, 0.02]) == 0.0
