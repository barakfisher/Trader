"""A resolved symbol's place in the universe: a member, outside the screen by
rule, or a real gap - and never a gap when the question could not be asked."""

from __future__ import annotations

import pytest

from app.models import Instrument
from app.universe.membership import universe_status
from app.universe.snapshot import PRIMARY_US_EXCHANGES, screen_exclusion

US_VENUE = PRIMARY_US_EXCHANGES[0]


class Members:
    def __init__(self, *symbols: str) -> None:
        self.symbols = set(symbols)

    def contains(self, symbol: str) -> bool:
        return symbol in self.symbols


class Unreachable:
    def contains(self, symbol: str) -> bool:
        raise ConnectionError("database is down")


def _instrument(symbol: str, asset_class: str, exchange: str | None) -> Instrument:
    return Instrument(symbol=symbol, asset_class=asset_class, exchange=exchange)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("asset_class", "exchange", "expected"),
    [
        ("equity", US_VENUE, None),
        ("etf", US_VENUE, None),
        ("crypto", "CCC", "asset_class"),
        ("fx", None, "asset_class"),
        # Checked first: a crypto pair is out for what it is, not where it trades.
        ("crypto", US_VENUE, "asset_class"),
        ("equity", "GER", "exchange"),
        ("equity", None, "exchange"),
    ],
)
def test_the_screen_rule_a_listing_fails_whatever_its_size(
    asset_class: str, exchange: str | None, expected: str | None
) -> None:
    assert screen_exclusion(asset_class, exchange) == expected


def test_a_member_is_a_member() -> None:
    status = universe_status(_instrument("AAPL", "equity", US_VENUE), Members("AAPL"))
    assert status is not None and status.member and status.outside_screen is None


def test_a_listing_outside_the_screen_says_which_rule() -> None:
    status = universe_status(_instrument("SAP.DE", "equity", "GER"), Members())
    assert status is not None
    assert (status.member, status.outside_screen) == (False, "exchange")


def test_a_us_listing_the_universe_lacks_is_a_real_gap() -> None:
    status = universe_status(_instrument("TINY", "equity", US_VENUE), Members())
    assert status is not None
    assert (status.member, status.outside_screen) == (False, None)


def test_an_unanswerable_question_is_not_reported_as_a_gap() -> None:
    assert universe_status(_instrument("AAPL", "equity", US_VENUE), Unreachable()) is None


class NoUniverse:
    def contains(self, symbol: str) -> None:
        return None


def test_an_installation_with_no_universe_reports_no_gaps() -> None:
    assert universe_status(_instrument("AAPL", "equity", US_VENUE), NoUniverse()) is None


def test_nothing_resolved_has_no_membership() -> None:
    assert universe_status(None, Members("AAPL")) is None
