"""Rule 2: the move expressed in sigmas.

The series below are fixed and small enough to reason about by hand: a quiet
instrument that alternates between 100.00 and 100.50, then one final day that is
the event under test. Expected z-scores are written as literals so a failure names
a number rather than a formula.
"""

from datetime import UTC, datetime, timedelta

import pytest

from app.analysis.findings import SeverityBands
from app.analysis.price_series import PricePoint
from app.analysis.sigma_move import FLOORED_SEVERITY_CEILING, sigma_move_findings
from app.analysis.thresholds import AnalysisThresholds

MONDAY_CLOSE = datetime(2026, 3, 2, 20, 0, tzinfo=UTC)

SIGMA_BANDS = SeverityBands(info=2.0, notable=3.0, high=4.0)
THRESHOLDS = AnalysisThresholds(
    sigma_move=SIGMA_BANDS,
    sigma_window_days=30,
    sigma_min_observations=10,
    sigma_min_move=0.01,
    sigma_stdev_floor=0.0025,
    max_gap_days=5,
)

#: Eleven observations, so ten prior returns: exactly the minimum sample. Prices
#: alternate 100.00 / 100.50, a genuinely quiet instrument.
QUIET = [10000, 10050, 10000, 10050, 10000, 10050, 10000, 10050, 10000, 10050, 10000]

#: Eleven observations that move by one cent a day: too quiet to divide by.
BARELY_MOVING = [10000, 10001, 10000, 10001, 10000, 10001, 10000, 10001, 10000, 10001, 10000]


def series(prices: list[int], currency: str = "USD") -> list[PricePoint]:
    return [
        PricePoint(MONDAY_CLOSE + timedelta(days=index), price, currency)
        for index, price in enumerate(prices)
    ]


# -- happy path ---------------------------------------------------------------


def test_a_five_percent_fall_in_a_quiet_name_is_a_high_severity_sigma_finding():
    (finding,) = sigma_move_findings("AAPL", series([*QUIET, 9500]), THRESHOLDS)

    assert finding.kind == "sigma_move"
    assert finding.severity == "high"
    assert finding.subject_ref == "instrument:AAPL"
    assert finding.as_of == MONDAY_CLOSE + timedelta(days=11)

    evidence = finding.evidence
    assert evidence["sample_size"] == 10
    assert evidence["change_pct"] == pytest.approx(-0.05)
    # The ten prior returns alternate +0.5% and -0.497...%, giving a sample
    # deviation of 0.005257352163049; -0.05 divided by that is -9.5105 sigmas.
    assert evidence["return_stdev"] == pytest.approx(0.00525735216304942, rel=1e-12)
    assert evidence["z_score"] == pytest.approx(-9.510490918112383, rel=1e-12)
    assert evidence["return_stdev_floor_applied"] is False
    assert evidence["return_stdev_used"] == evidence["return_stdev"]
    assert evidence["price_minor"] == 9500
    assert evidence["previous_price_minor"] == 10000
    assert evidence["window_days"] == THRESHOLDS.sigma_window_days
    assert evidence["thresholds_sigma"] == SIGMA_BANDS.as_evidence()


def test_the_same_move_in_a_volatile_name_is_not_a_finding():
    # This is the rule's entire reason for existing. Identical final day, -5%, on
    # an instrument that routinely swings 8%: not unusual, so not reported.
    volatile = [10000, 10800, 10000, 10800, 10000, 10800, 10000, 10800, 10000, 10800, 10000]
    assert sigma_move_findings("SMR", series([*volatile, 9500]), THRESHOLDS) == []


# -- the sample excludes today ------------------------------------------------


def test_todays_move_does_not_inflate_its_own_denominator():
    # If today's return were in the sample, a larger move would enlarge the
    # deviation and the z-score would barely grow. Excluding it keeps the
    # denominator fixed, so doubling the move doubles the sigmas.
    small = sigma_move_findings("AAPL", series([*QUIET, 9700]), THRESHOLDS)[0].evidence
    large = sigma_move_findings("AAPL", series([*QUIET, 9400]), THRESHOLDS)[0].evidence

    assert small["return_stdev"] == large["return_stdev"]
    assert large["z_score"] == pytest.approx(2 * small["z_score"], rel=1e-12)


# -- severity boundaries ------------------------------------------------------


def test_the_bands_are_where_the_z_score_says_they_are():
    # The deviation of the QUIET sample is 0.005257352163049, so the band edges
    # fall at -1.05%, -1.58% and -2.10% of a fall. The prices below straddle them.
    def severity(price_minor: int) -> str | None:
        found = sigma_move_findings("AAPL", series([*QUIET, price_minor]), THRESHOLDS)
        return found[0].severity if found else None

    assert severity(9896) is None  # -1.04%: under 2 sigma
    assert severity(9894) == "info"  # -1.06%: just over 2 sigma
    assert severity(9841) == "notable"  # -1.59%: just over 3 sigma
    assert severity(9789) == "high"  # -2.11%: just over 4 sigma


# -- edge cases ---------------------------------------------------------------


def test_too_little_history_produces_nothing_rather_than_a_confident_number():
    short = [10000, 10050, 10000, 10050, 10000]
    assert sigma_move_findings("AAPL", series([*short, 9500]), THRESHOLDS) == []


def test_a_sample_one_observation_short_is_still_refused():
    # Nine prior returns against a minimum of ten: the answer would look
    # identical to a valid one, which is exactly why the boundary is tested.
    assert sigma_move_findings("AAPL", series([*QUIET[1:], 9500]), THRESHOLDS) == []


def test_a_flat_series_yields_no_z_score_and_no_division_by_zero():
    flat = [10000] * 11
    assert sigma_move_findings("AAPL", series([*flat, 9500]), THRESHOLDS) == []


def test_a_near_flat_series_uses_the_floor_and_is_capped():
    # The one-cent-a-day sample deviates 0.000105..., far below the 0.0025 floor.
    # 1.5% over the floor is exactly 6 sigma, which would be "high"; because the
    # floor rather than the data produced that number, it is capped.
    (finding,) = sigma_move_findings("QUIET", series([*BARELY_MOVING, 10150]), THRESHOLDS)

    assert finding.severity == FLOORED_SEVERITY_CEILING
    assert finding.evidence["return_stdev_floor_applied"] is True
    assert finding.evidence["return_stdev_used"] == THRESHOLDS.sigma_stdev_floor
    assert finding.evidence["z_score"] == pytest.approx(6.0, rel=1e-9)


def test_a_tiny_move_is_not_reported_however_many_sigmas_it_is():
    # +0.5% against the one-cent sample is nearly 50 sigma before the floor and
    # 2 sigma after it. Either way it is noise, and the minimum-move guard is what
    # says so.
    assert sigma_move_findings("QUIET", series([*BARELY_MOVING, 10050]), THRESHOLDS) == []


def test_an_outage_before_today_is_excluded_from_the_sample():
    # A 21-day hole with a 12% jump across it: that step is not a daily return, so
    # it must not enter the volatility estimate and inflate it. The window is
    # widened here only so that the quiet history still fits behind the hole.
    wide = AnalysisThresholds(
        sigma_move=SIGMA_BANDS,
        sigma_window_days=60,
        sigma_min_observations=10,
        sigma_min_move=0.01,
        sigma_stdev_floor=0.0025,
    )
    points = series(QUIET)
    resumed = [
        PricePoint(points[-1].as_of + timedelta(days=21), 11200, "USD"),
        PricePoint(points[-1].as_of + timedelta(days=22), 10640, "USD"),
    ]
    (finding,) = sigma_move_findings("TEVA", [*points, *resumed], wide)

    assert finding.evidence["sample_size"] == 10
    assert finding.evidence["return_stdev"] == pytest.approx(0.00525735216304942, rel=1e-12)


def test_an_outage_ending_today_produces_nothing():
    points = series(QUIET)
    resumed = PricePoint(points[-1].as_of + timedelta(days=21), 9500, "USD")
    assert sigma_move_findings("TEVA", [*points, resumed], THRESHOLDS) == []


def test_the_window_bounds_the_sample():
    # Six days of window anchored on the last observation: seven points, six
    # steps, one of which is today's and excluded.
    narrow = AnalysisThresholds(
        sigma_move=SIGMA_BANDS,
        sigma_window_days=6,
        sigma_min_observations=3,
        sigma_min_move=0.01,
        sigma_stdev_floor=0.0025,
    )
    (finding,) = sigma_move_findings("AAPL", series([*QUIET, 9500]), narrow)
    assert finding.evidence["sample_size"] == 5


def test_a_change_of_denomination_produces_nothing():
    points = [*series(QUIET), PricePoint(MONDAY_CLOSE + timedelta(days=11), 8700, "EUR")]
    assert sigma_move_findings("SAP.DE", points, THRESHOLDS) == []
