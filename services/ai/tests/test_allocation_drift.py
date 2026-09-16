"""Rule 4: actual weight against target weight.

Values here are integer minor units of one base currency, because that is exactly
what the rule demands of its caller. Weights are Decimal, so the expected values
below are written as the strings a user would recognise.
"""

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from app.analysis.allocation_drift import PositionValue, allocation_drift_findings
from app.analysis.findings import SeverityBands
from app.analysis.thresholds import AnalysisThresholds

MONDAY_CLOSE = datetime(2026, 3, 2, 20, 0, tzinfo=UTC)

DRIFT_BANDS = SeverityBands(info=0.05, notable=0.10, high=0.15)
THRESHOLDS = AnalysisThresholds(allocation_drift=DRIFT_BANDS)

#: A 100,000.00 portfolio in four equal-ish parts, so every weight is exact.
POSITIONS = [
    PositionValue("AAPL", 4_000_000, "USD", MONDAY_CLOSE),
    PositionValue("MSFT", 3_000_000, "USD", MONDAY_CLOSE),
    PositionValue("VOO", 2_000_000, "USD", MONDAY_CLOSE),
    PositionValue("BTC-USD", 1_000_000, "USD", MONDAY_CLOSE),
]
EVEN_TARGETS = {
    "AAPL": Decimal("0.25"),
    "MSFT": Decimal("0.25"),
    "VOO": Decimal("0.25"),
    "BTC-USD": Decimal("0.25"),
}


# -- happy path ---------------------------------------------------------------


def test_drift_is_reported_per_instrument_with_both_weights():
    findings = allocation_drift_findings(POSITIONS, EVEN_TARGETS, THRESHOLDS, base_currency="USD")

    # 40 / 30 / 20 / 10 against 25 each: drifts of +15, +5, -5 and -15 points, so
    # all four clear the five-point floor and two of them sit exactly on it.
    assert [finding.evidence["symbol"] for finding in findings] == [
        "AAPL",
        "BTC-USD",
        "MSFT",
        "VOO",
    ]
    assert [finding.severity for finding in findings] == ["high", "high", "info", "info"]

    aapl, btc = findings[0], findings[1]
    assert aapl.kind == "allocation_drift"
    assert aapl.subject_ref == "portfolio:allocation:AAPL"
    assert aapl.severity == "high"  # 40% against 25%: fifteen points over, the high band
    assert aapl.evidence["actual_weight"] == "0.400000"
    assert aapl.evidence["target_weight"] == "0.250000"
    assert aapl.evidence["drift"] == "0.150000"
    assert aapl.evidence["value_minor"] == 4_000_000
    assert aapl.evidence["portfolio_total_minor"] == 10_000_000
    assert aapl.evidence["base_currency"] == "USD"
    assert aapl.evidence["target_weight_sum"] == "1.000000"
    assert aapl.evidence["held"] is True
    assert aapl.evidence["positions_valued"] == 4
    assert aapl.evidence["thresholds_weight"] == DRIFT_BANDS.as_evidence()

    # Underweight drifts are negative and equally reportable.
    assert btc.evidence["drift"] == "-0.150000"


def test_findings_are_ordered_by_symbol_so_a_rerun_matches():
    findings = allocation_drift_findings(POSITIONS, EVEN_TARGETS, THRESHOLDS, base_currency="USD")
    symbols = [finding.evidence["symbol"] for finding in findings]
    assert symbols == sorted(symbols)


def test_an_instrument_without_a_target_is_not_judged():
    # A holding the user never set a target for cannot have drifted from it.
    findings = allocation_drift_findings(
        POSITIONS, {"AAPL": Decimal("0.25")}, THRESHOLDS, base_currency="USD"
    )
    assert [finding.evidence["symbol"] for finding in findings] == ["AAPL"]


def test_a_target_with_no_holding_is_a_drift():
    # "You hold none of the 20% you asked for" is the finding this rule exists to
    # make, and it cannot be found by looking only at what is held.
    targets = {**EVEN_TARGETS, "URA": Decimal("0.20")}
    findings = allocation_drift_findings(POSITIONS, targets, THRESHOLDS, base_currency="USD")
    (ura,) = [finding for finding in findings if finding.evidence["symbol"] == "URA"]
    assert ura.evidence["actual_weight"] == "0.000000"
    assert ura.evidence["drift"] == "-0.200000"
    assert ura.evidence["held"] is False
    assert ura.severity == "high"


# -- severity boundaries ------------------------------------------------------


def test_the_bands_are_in_percentage_points_of_weight():
    def severity(target: str) -> str | None:
        # AAPL sits at exactly 40% of the portfolio.
        found = allocation_drift_findings(
            POSITIONS, {"AAPL": Decimal(target)}, THRESHOLDS, base_currency="USD"
        )
        return found[0].severity if found else None

    assert severity("0.3501") is None  # 4.99 points of drift
    assert severity("0.35") == "info"  # exactly five points
    assert severity("0.30") == "notable"  # ten points
    assert severity("0.25") == "high"  # fifteen points


# -- edge cases ---------------------------------------------------------------


def test_an_unpriced_holding_suppresses_every_drift_finding():
    # The denominator would be 60,000 instead of 100,000, so AAPL would read as
    # 66% and every weight in the portfolio would be overstated. Silence is the
    # only correct output; the run records the unpriced holding separately.
    positions = [*POSITIONS[:3], PositionValue("BTC-USD", None, "USD", None)]
    assert allocation_drift_findings(positions, EVEN_TARGETS, THRESHOLDS, base_currency="USD") == []


def test_an_empty_portfolio_produces_nothing():
    assert allocation_drift_findings([], EVEN_TARGETS, THRESHOLDS, base_currency="USD") == []


def test_no_targets_produce_nothing():
    assert allocation_drift_findings(POSITIONS, {}, THRESHOLDS, base_currency="USD") == []


def test_a_worthless_portfolio_produces_nothing_rather_than_dividing_by_zero():
    positions = [PositionValue("AAPL", 0, "USD", MONDAY_CLOSE)]
    assert allocation_drift_findings(positions, EVEN_TARGETS, THRESHOLDS, base_currency="USD") == []


def test_a_position_in_another_currency_is_a_wiring_error_not_a_finding():
    # Treating a EUR value as USD would misstate every weight in the portfolio, so
    # this raises rather than guessing at an FX rate the rule does not have.
    positions = [*POSITIONS[:3], PositionValue("SAP.DE", 1_000_000, "EUR", MONDAY_CLOSE)]
    with pytest.raises(ValueError, match="convert to the base currency"):
        allocation_drift_findings(positions, EVEN_TARGETS, THRESHOLDS, base_currency="USD")


def test_the_finding_is_dated_by_the_stalest_price_behind_it():
    # A weight is only as current as the oldest price that went into the total.
    stale = PositionValue("AAPL", 4_000_000, "USD", MONDAY_CLOSE - timedelta(days=3))
    findings = allocation_drift_findings(
        [stale, *POSITIONS[1:]], EVEN_TARGETS, THRESHOLDS, base_currency="USD"
    )
    assert all(finding.as_of == MONDAY_CLOSE - timedelta(days=3) for finding in findings)
    assert findings[0].evidence["as_of"] == "2026-02-27T20:00:00+00:00"


def test_targets_that_do_not_sum_to_one_are_reported_not_renormalised():
    # A user may set targets for two of four holdings. Renormalising them would
    # invent intentions they never expressed, so the sum is evidence instead.
    targets = {"AAPL": Decimal("0.20"), "MSFT": Decimal("0.20")}
    findings = allocation_drift_findings(POSITIONS, targets, THRESHOLDS, base_currency="USD")
    aapl, msft = findings
    assert aapl.evidence["target_weight_sum"] == "0.400000"
    # Weights are still shares of the whole portfolio: AAPL is 40% of 100,000, not
    # 40% of the 70,000 the two targets cover.
    assert aapl.evidence["drift"] == "0.200000"
    assert msft.evidence["drift"] == "0.100000"


def test_weights_stay_exact_where_a_float_would_drift():
    # A third of a portfolio is 0.333333... and a target of 1/3 is stored as
    # 0.3333; the drift is the exact difference of the two decimals, not a float's
    # idea of it.
    positions = [
        PositionValue("AAPL", 1_000_000, "USD", MONDAY_CLOSE),
        PositionValue("MSFT", 1_000_000, "USD", MONDAY_CLOSE),
        PositionValue("VOO", 1_000_000, "USD", MONDAY_CLOSE),
    ]
    findings = allocation_drift_findings(
        positions, {"AAPL": Decimal("0.2500")}, THRESHOLDS, base_currency="USD"
    )
    (aapl,) = findings
    assert aapl.evidence["actual_weight"] == "0.333333"
    assert aapl.evidence["drift"] == "0.083333"


def test_targets_may_arrive_as_strings():
    # `target_weights.weight` is numeric(6, 4); a driver that hands back a string
    # must not silently become a float on the way in.
    findings = allocation_drift_findings(
        POSITIONS, {"AAPL": "0.25"}, THRESHOLDS, base_currency="USD"
    )
    assert findings[0].evidence["target_weight"] == "0.250000"
