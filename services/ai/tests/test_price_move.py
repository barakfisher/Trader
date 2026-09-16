"""Rule 1: the one-day move.

Thresholds are stated in the test's own `BANDS` so the assertions describe the
ladder rather than whichever defaults ship today.
"""

from datetime import UTC, datetime, timedelta

from app.analysis.findings import SeverityBands
from app.analysis.price_move import price_move_findings
from app.analysis.price_series import PricePoint
from app.analysis.thresholds import AnalysisThresholds

MONDAY_CLOSE = datetime(2026, 3, 2, 20, 0, tzinfo=UTC)

BANDS = SeverityBands(info=0.03, notable=0.05, high=0.08)
THRESHOLDS = AnalysisThresholds(price_move=BANDS, max_gap_days=5)


def at(day_offset: float, price_minor: int, currency: str = "USD") -> PricePoint:
    return PricePoint(MONDAY_CLOSE + timedelta(days=day_offset), price_minor, currency)


# -- happy path ---------------------------------------------------------------


def test_a_four_percent_day_is_an_info_finding_with_its_numbers_attached():
    (finding,) = price_move_findings("AAPL", [at(0, 10000), at(1, 10400)], THRESHOLDS)

    assert finding.kind == "price_move"
    assert finding.severity == "info"
    assert finding.subject_ref == "instrument:AAPL"
    assert finding.as_of == MONDAY_CLOSE + timedelta(days=1)

    evidence = finding.evidence
    assert evidence["price_minor"] == 10400
    assert evidence["previous_price_minor"] == 10000
    assert evidence["change_minor"] == 400
    assert evidence["change_pct"] == 0.04
    assert evidence["currency"] == "USD"
    assert evidence["gap_days"] == 1.0
    assert evidence["as_of"] == "2026-03-03T20:00:00+00:00"
    assert evidence["previous_as_of"] == "2026-03-02T20:00:00+00:00"
    assert evidence["thresholds_pct"] == BANDS.as_evidence()


def test_a_fall_is_reported_with_a_negative_change():
    (finding,) = price_move_findings("NVDA", [at(0, 10000), at(1, 9400)], THRESHOLDS)
    assert finding.severity == "notable"
    assert finding.evidence["change_minor"] == -600
    assert finding.evidence["change_pct"] == -0.06


def test_only_the_latest_move_is_reported():
    # Yesterday's 6% is history; the pipeline evaluates the current state, and an
    # older move would arrive with a stale `as_of` and duplicate an earlier run.
    series = [at(0, 10000), at(1, 10600), at(2, 10600)]
    assert price_move_findings("AAPL", series, THRESHOLDS) == []


# -- severity boundaries ------------------------------------------------------


def test_the_bands_are_where_the_prices_say_they_are():
    def severity(price_minor: int) -> str | None:
        found = price_move_findings("AAPL", [at(0, 10000), at(1, price_minor)], THRESHOLDS)
        return found[0].severity if found else None

    assert severity(10299) is None  # 2.99%
    assert severity(10300) == "info"  # exactly the floor
    assert severity(10500) == "notable"
    assert severity(10800) == "high"


# -- edge cases ---------------------------------------------------------------


def test_a_single_observation_produces_nothing():
    assert price_move_findings("AAPL", [at(0, 10000)], THRESHOLDS) == []


def test_an_empty_series_produces_nothing():
    assert price_move_findings("AAPL", [], THRESHOLDS) == []


def test_a_weekend_gap_is_still_a_daily_move():
    # Friday to Monday: three calendar days, one trading step.
    (finding,) = price_move_findings("AAPL", [at(0, 10000), at(3, 10600)], THRESHOLDS)
    assert finding.severity == "notable"
    assert finding.evidence["gap_days"] == 3.0


def test_a_symbol_that_stopped_being_priced_gets_no_daily_move():
    # Twenty-one days apart: whatever happened, it was not a one-day move, and
    # saying otherwise would be a false statement with a real number attached.
    assert price_move_findings("TEVA", [at(0, 10000), at(21, 11200)], THRESHOLDS) == []


def test_a_zero_price_is_dropped_instead_of_producing_a_total_loss():
    # The bad row is discarded, so the comparison falls back to the two real
    # prices around it - 10000 to 10400, not 10000 to zero.
    series = [at(0, 10000), at(1, 0), at(2, 10400)]
    (finding,) = price_move_findings("AAPL", series, THRESHOLDS)
    assert finding.evidence["change_pct"] == 0.04
    # ...and the gap it spans is reported honestly as two days.
    assert finding.evidence["gap_days"] == 2.0


def test_a_change_of_denomination_produces_nothing():
    # The last pair crosses currencies, so there is no latest move to report. The
    # older USD pair must not be dressed up as today's.
    series = [at(0, 10000, "USD"), at(1, 10600, "USD"), at(2, 9800, "EUR")]
    assert price_move_findings("SAP.DE", series, THRESHOLDS) == []


def test_a_repeated_observation_time_does_not_manufacture_a_flat_day():
    # Two rows for one observation collapse into one point, leaving a single step.
    series = [at(0, 10000), at(1, 10400), at(1, 10400)]
    (finding,) = price_move_findings("AAPL", series, THRESHOLDS)
    assert finding.evidence["change_pct"] == 0.04


def test_input_order_does_not_matter():
    shuffled = [at(1, 10400), at(0, 10000)]
    (finding,) = price_move_findings("AAPL", shuffled, THRESHOLDS)
    assert finding.evidence["change_pct"] == 0.04
