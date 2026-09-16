"""Golden case: the four rules over the demo portfolio in `data/fixtures`.

The numbers here are recognisable - they are the prices the offline demo and CI
serve - so a regression shows up as "NVDA is no longer notable" rather than as an
arithmetic mismatch in an abstract series. The fixture prices are invented but
fixed, which is what makes them usable as a golden case.

`quotes.json` holds a price and a previous close per symbol, so it supports the
two-point rules directly. The σ rule needs history the fixtures do not have, and
is tested against explicit series in `test_sigma_move.py` instead.
"""

import json
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from app.analysis import (
    AnalysisThresholds,
    PositionValue,
    PricePoint,
    allocation_drift_findings,
    price_move_findings,
)
from app.core.money import to_minor
from tests.conftest import FIXTURES_DIR

THRESHOLDS = AnalysisThresholds()

#: Two close observations a day apart. The fixtures carry no timestamps, so the
#: dates are the test's; only the interval matters to the rules.
YESTERDAY_CLOSE = datetime(2026, 3, 2, 21, 0, tzinfo=UTC)
TODAY_CLOSE = YESTERDAY_CLOSE + timedelta(days=1)

#: Target weights are a user's choice and live in `target_weights`, not in the
#: fixtures. These are a plausible set for the demo holdings: an equity core, an
#: index sleeve, and a quarter in bitcoin.
DEMO_TARGETS = {
    "AAPL": Decimal("0.20"),
    "MSFT": Decimal("0.15"),
    "NVDA": Decimal("0.15"),
    "VOO": Decimal("0.25"),
    "BTC-USD": Decimal("0.25"),
}


def fixture_prices() -> dict[str, dict]:
    return json.loads((FIXTURES_DIR / "quotes.json").read_text())["prices"]


def demo_holdings() -> list[dict]:
    return json.loads((FIXTURES_DIR / "demo-portfolio.json").read_text())["holdings"]


def fixture_series(symbol: str) -> list[PricePoint]:
    """Yesterday's close and today's price for `symbol`, as integer minor units.

    The JSON numbers become `Decimal` via `str` and then minor units exactly once:
    that conversion is the boundary where money stops being a decimal literal and
    starts being an integer, and nothing downstream of it sees a float.
    """
    quote = fixture_prices()[symbol]
    currency = quote["currency"]
    return [
        PricePoint(
            YESTERDAY_CLOSE, to_minor(Decimal(str(quote["previous_close"])), currency), currency
        ),
        PricePoint(TODAY_CLOSE, to_minor(Decimal(str(quote["price"])), currency), currency),
    ]


def demo_positions() -> list[PositionValue]:
    """The demo holdings valued at fixture prices, in USD minor units."""
    prices = fixture_prices()
    positions = []
    for holding in demo_holdings():
        quote = prices[holding["symbol"]]
        # Every demo holding is USD-denominated, so no FX step is involved; a
        # portfolio with a EUR listing would be converted by the valuation step
        # before reaching this rule.
        assert quote["currency"] == "USD"
        value = Decimal(str(holding["quantity"])) * Decimal(str(quote["price"]))
        positions.append(
            PositionValue(holding["symbol"], to_minor(value, "USD"), "USD", TODAY_CLOSE)
        )
    return positions


# -- price move over the fixture prices ---------------------------------------


def test_nuscale_is_the_high_severity_mover_in_the_fixtures():
    # 8.92 to 9.87 is +10.65%, past the 8% high band.
    (finding,) = price_move_findings("SMR", fixture_series("SMR"), THRESHOLDS)
    assert finding.severity == "high"
    assert finding.evidence["previous_price_minor"] == 892
    assert finding.evidence["price_minor"] == 987
    assert finding.evidence["change_minor"] == 95
    assert round(finding.evidence["change_pct"], 6) == 0.106502


def test_nvidia_is_notable():
    # 124.90 to 118.45 is -5.16%, past the 5% notable band and short of 8%.
    (finding,) = price_move_findings("NVDA", fixture_series("NVDA"), THRESHOLDS)
    assert finding.severity == "notable"
    assert finding.evidence["change_minor"] == -645
    assert round(finding.evidence["change_pct"], 6) == -0.051641


def test_apple_moved_but_not_enough_to_say_anything():
    # +1.02%: a real move, below the floor, and therefore no finding at all.
    assert price_move_findings("AAPL", fixture_series("AAPL"), THRESHOLDS) == []


def test_a_euro_listing_is_measured_in_euros():
    # SAP.DE is quoted in EUR: 194.05 to 196.40, a 1.21% move that is below the
    # floor. What matters is that the prices reaching the rule are EUR minor units
    # and are never converted - a move in a EUR-listed share is a fact about that
    # share, and multiplying it by an FX rate would produce a number that is
    # neither its move nor the portfolio's.
    series = fixture_series("SAP.DE")
    assert [point.currency for point in series] == ["EUR", "EUR"]
    assert [point.price_minor for point in series] == [19405, 19640]
    assert price_move_findings("SAP.DE", series, THRESHOLDS) == []


# -- allocation drift over the demo portfolio ---------------------------------


def test_the_demo_portfolio_is_valued_in_integer_minor_units():
    values = {position.symbol: position.value_minor for position in demo_positions()}
    assert values == {
        "AAPL": 580_350,  # 25 x 232.14
        "MSFT": 502_344,  # 12 x 418.62
        "NVDA": 473_800,  # 40 x 118.45
        "VOO": 921_744,  # 18 x 512.08
        "BTC-USD": 2_453_318,  # 0.42 x 58,412.33, rounded once, at this boundary
    }
    assert sum(values.values()) == 4_931_556  # 49,315.56 USD


def test_bitcoin_has_drifted_to_half_the_demo_portfolio():
    findings = allocation_drift_findings(
        demo_positions(), DEMO_TARGETS, THRESHOLDS, base_currency="USD"
    )
    by_symbol = {finding.evidence["symbol"]: finding for finding in findings}

    btc = by_symbol["BTC-USD"]
    assert btc.severity == "high"
    assert btc.evidence["actual_weight"] == "0.497473"
    assert btc.evidence["target_weight"] == "0.250000"
    assert btc.evidence["drift"] == "0.247473"
    assert btc.evidence["portfolio_total_minor"] == 4_931_556
    assert btc.as_of == TODAY_CLOSE

    # The three names bitcoin crowded out are all underweight, and MSFT - at 10.2%
    # against a 15% target - is 4.8 points off and stays below the floor.
    assert set(by_symbol) == {"AAPL", "BTC-USD", "NVDA", "VOO"}
    assert by_symbol["AAPL"].evidence["drift"] == "-0.082319"
    assert by_symbol["NVDA"].evidence["drift"] == "-0.053925"
    assert by_symbol["VOO"].evidence["drift"] == "-0.063093"


def test_the_demo_targets_sum_to_one():
    # Stated so that the weights above are readable as shares of a whole
    # portfolio; the rule itself never assumes it.
    assert sum(DEMO_TARGETS.values()) == Decimal("1")
