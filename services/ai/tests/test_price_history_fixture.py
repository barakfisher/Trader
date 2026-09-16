"""Invariants of the price-history fixture.

The analysis tests downstream assert specific findings against this data, so the
fixture's shape is part of the contract rather than incidental. A regenerated
series that quietly lost its planted event would turn those tests into a mystery.
"""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import pytest

FIXTURES = Path(__file__).resolve().parents[3] / "data" / "fixtures"


@pytest.fixture(scope="module")
def series() -> dict[str, list[dict]]:
    return json.loads((FIXTURES / "price-history.json").read_text())["series"]


@pytest.fixture(scope="module")
def spot() -> dict[str, dict]:
    return json.loads((FIXTURES / "quotes.json").read_text())["prices"]


def closes(points: list[dict]) -> list[float]:
    return [float(point["close"]) for point in points]


def test_every_priced_symbol_has_history(series, spot):
    assert set(series) == set(spot)


#: Symbols whose last close deliberately differs from spot, so that the step into
#: today's live quote is itself the event the rules should catch.
PLANTED = {"NVDA": -0.085}


def test_quiet_series_end_at_the_spot_price(series, spot):
    # History that disagrees with the current quote makes any failure downstream
    # impossible to interpret: you cannot tell the rule from the data.
    for symbol, points in series.items():
        if symbol in PLANTED:
            continue
        assert closes(points)[-1] == pytest.approx(float(spot[symbol]["price"])), symbol


def test_history_stops_before_the_spot_quote(series):
    # The series must not run up to the spot day. If it did, the newest step
    # would be seeded-close to live-quote at the same price - a flat step that
    # buries the planted event where the latest-move rules cannot see it.
    ends = {points[-1]["date"] for points in series.values()}
    assert len(ends) == 1, ends


def test_dates_are_unique_and_ascending(series):
    for symbol, points in series.items():
        days = [date.fromisoformat(point["date"]) for point in points]
        assert days == sorted(days), symbol
        assert len(set(days)) == len(days), symbol


def test_equities_skip_weekends_and_crypto_does_not(series):
    equity_days = [date.fromisoformat(p["date"]) for p in series["AAPL"]]
    assert all(day.weekday() < 5 for day in equity_days)
    crypto_days = [date.fromisoformat(p["date"]) for p in series["BTC-USD"]]
    assert any(day.weekday() >= 5 for day in crypto_days)


def test_planted_drop_is_the_step_into_the_spot_quote(series, spot):
    # NVDA carries the event the price-move and sigma rules are meant to catch,
    # realised by today's live quote rather than sitting inside history.
    for symbol, expected in PLANTED.items():
        last_close = closes(series[symbol])[-1]
        move = float(spot[symbol]["price"]) / last_close - 1
        assert move == pytest.approx(expected, abs=0.002), symbol


def test_quiet_symbol_stays_below_the_reporting_threshold(series):
    # MSFT exists to prove the rules discriminate: if everything triggers, the
    # thresholds are decoration.
    values = closes(series["MSFT"])
    # Not strict: pairing a series with itself offset by one is intentionally
    # ragged, and strict=True would raise on the length difference.
    moves = [abs(b / a - 1) for a, b in zip(values, values[1:])]  # noqa: B905
    assert max(moves) < 0.03


def test_sustained_decline_is_present_for_drawdown(series):
    values = closes(series["TAN"])
    peak, worst = values[0], 0.0
    for value in values:
        peak = max(peak, value)
        worst = min(worst, value / peak - 1)
    assert worst < -0.25


def test_enough_history_for_the_sigma_window(series):
    # The sigma rule needs at least ten observations before it will say anything.
    for symbol, points in series.items():
        assert len(points) >= 30, symbol
