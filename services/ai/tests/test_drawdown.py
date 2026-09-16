"""Rule 3: the decline from a trailing high."""

from datetime import UTC, datetime, timedelta

from app.analysis.drawdown import drawdown_findings
from app.analysis.findings import SeverityBands
from app.analysis.price_series import PricePoint
from app.analysis.thresholds import AnalysisThresholds

MONDAY_CLOSE = datetime(2026, 3, 2, 20, 0, tzinfo=UTC)

DRAWDOWN_BANDS = SeverityBands(info=0.10, notable=0.15, high=0.25)
THRESHOLDS = AnalysisThresholds(
    drawdown=DRAWDOWN_BANDS,
    drawdown_window_days=30,
    drawdown_min_observations=5,
)


def series(prices: list[int], currency: str = "USD", step_days: int = 1) -> list[PricePoint]:
    return [
        PricePoint(MONDAY_CLOSE + timedelta(days=index * step_days), price, currency)
        for index, price in enumerate(prices)
    ]


# -- happy path ---------------------------------------------------------------


def test_a_fifteen_percent_slide_from_the_high_is_a_notable_finding():
    # 110.00 on day 1 down to 93.50 on day 4: exactly -15%, and not one day of it
    # is a 3% move, so no other rule in the package would mention it.
    (finding,) = drawdown_findings("SMR", series([10000, 11000, 10500, 9900, 9350]), THRESHOLDS)

    assert finding.kind == "drawdown"
    assert finding.severity == "notable"
    assert finding.subject_ref == "instrument:SMR"
    assert finding.as_of == MONDAY_CLOSE + timedelta(days=4)

    evidence = finding.evidence
    assert evidence["drawdown_pct"] == -0.15
    assert evidence["high_price_minor"] == 11000
    assert evidence["high_as_of"] == "2026-03-03T20:00:00+00:00"
    assert evidence["price_minor"] == 9350
    assert evidence["observations_used"] == 5
    assert evidence["window_days"] == THRESHOLDS.drawdown_window_days
    assert evidence["currency"] == "USD"
    assert evidence["thresholds_pct"] == DRAWDOWN_BANDS.as_evidence()


def test_the_high_is_local_to_the_window():
    # The 200.00 print is 60 days old and outside a 30-day window, so the
    # drawdown is measured from 110.00 - this is a local high by construction, not
    # an all-time high.
    old_peak = [PricePoint(MONDAY_CLOSE, 20000, "USD")]
    recent = [
        PricePoint(MONDAY_CLOSE + timedelta(days=60 + index), price, "USD")
        for index, price in enumerate([10000, 11000, 10500, 9900, 9350])
    ]
    (finding,) = drawdown_findings("SMR", [*old_peak, *recent], THRESHOLDS)
    assert finding.evidence["high_price_minor"] == 11000
    assert finding.evidence["observations_used"] == 5


# -- severity boundaries ------------------------------------------------------


def test_the_bands_are_where_the_prices_say_they_are():
    def severity(last_price_minor: int) -> str | None:
        prices = [10000, 11000, 10800, 10600, last_price_minor]
        found = drawdown_findings("SMR", series(prices), THRESHOLDS)
        return found[0].severity if found else None

    assert severity(9901) is None  # -9.99% from 110.00
    assert severity(9900) == "info"  # exactly -10%
    assert severity(9350) == "notable"  # -15%
    assert severity(8250) == "high"  # -25%


# -- edge cases ---------------------------------------------------------------


def test_too_few_points_in_the_window_produce_nothing():
    # Four observations: the "high" is likely just the first price we hold, and a
    # drawdown from it would be an artefact of our coverage rather than a decline.
    assert drawdown_findings("SMR", series([11000, 10500, 9900, 9350]), THRESHOLDS) == []


def test_an_empty_series_produces_nothing():
    assert drawdown_findings("SMR", [], THRESHOLDS) == []


def test_a_series_at_its_high_produces_nothing():
    assert drawdown_findings("SMR", series([9000, 9500, 10000, 10500, 11000]), THRESHOLDS) == []


def test_a_flat_series_produces_nothing():
    # The high is the first point and equals the last, so the decline is zero; the
    # earliest-wins tie rule must not turn that into a finding.
    assert drawdown_findings("SMR", series([10000] * 6), THRESHOLDS) == []


def test_gaps_do_not_shrink_the_window_to_nothing():
    # Weekly observations spanning 28 days: sparse, but five real points inside a
    # 30-day window, and the decline they describe is real.
    (finding,) = drawdown_findings(
        "TEVA", series([10000, 11000, 10500, 9900, 9350], step_days=7), THRESHOLDS
    )
    assert finding.evidence["drawdown_pct"] == -0.15
    assert finding.evidence["observations_used"] == 5


def test_mixed_currencies_in_the_window_produce_nothing():
    # The maximum of a EUR price and a USD price is not a price.
    prices = series([10000, 11000, 10500, 9900, 9350])
    mixed = [*prices[:2], PricePoint(prices[2].as_of, 10500, "EUR"), *prices[3:]]
    assert drawdown_findings("SAP.DE", mixed, THRESHOLDS) == []


def test_a_zero_price_is_dropped_instead_of_becoming_a_total_loss():
    # Without the filter the last point reads as a 100% drawdown - the single worst
    # wrong finding this rule could emit. With it, the decline reported is the real
    # one, from 110.00 to 98.00.
    (finding,) = drawdown_findings("SMR", series([10000, 11000, 10500, 9900, 9800, 0]), THRESHOLDS)
    assert finding.evidence["price_minor"] == 9800
    assert finding.evidence["drawdown_pct"] == (9800 - 11000) / 11000
