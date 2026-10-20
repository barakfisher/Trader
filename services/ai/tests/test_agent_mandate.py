"""An agent's mandate, checked without a database (D165, D171-D173).

The rules are pure functions of the mandate, the instrument's profile and the
agent's book; `integration/test_agent_mandate_sql.py` runs them inside a scan.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from app.agents.answer import Trade
from app.agents.mandate import (
    LARGE_CAP_FLOOR_MINOR,
    MEGA_CAP_FLOOR_MINOR,
    MID_CAP_FLOOR_MINOR,
    RISK_BANDS,
    Mandate,
    _Book,
    _Profile,
    cap_band,
    mandate_brief,
    percent,
    risk_band,
    size_problems,
    universe_problems,
)
from app.core.fees import fee_minor

URANIUM_MINER = _Profile("equity", "Energy", "Uranium", None, LARGE_CAP_FLOOR_MINOR, "USD")
GOLD_MINERS_ETF = _Profile("etf", None, None, "Equity Precious Metals", None, None)
BROAD_ETF = _Profile("etf", None, None, "Large Blend", None, None)


def _buy(quantity: int, price_minor: int, symbol: str = "CCJ") -> Trade:
    return Trade("buy", symbol, quantity, "why", price_minor=price_minor)


def _book(cash: int, holdings: dict[str, int] | None = None, symbol: str = "CCJ") -> _Book:
    held = holdings or {}
    return _Book(
        cash_minor=cash,
        holdings_cost=Decimal(sum(held.values())),
        symbol_cost=Decimal(held.get(symbol, 0)),
        held_symbols=frozenset(held),
    )


def test_risk_bands_cover_one_to_ten_in_pairs() -> None:
    assert [risk_band(level) for level in range(1, 11)] == [
        band for band in RISK_BANDS for _ in range(2)
    ]
    assert risk_band(None) is None


def test_percent_reads_basis_points_as_a_person_would() -> None:
    assert (percent(1000), percent(1250), percent(5)) == ("10", "12.5", "0.05")


def test_cap_bands_start_at_their_floors() -> None:
    assert cap_band(MEGA_CAP_FLOOR_MINOR) == "mega"
    assert cap_band(MEGA_CAP_FLOOR_MINOR - 1) == "large"
    assert cap_band(LARGE_CAP_FLOOR_MINOR) == "large"
    assert cap_band(MID_CAP_FLOOR_MINOR) == "mid"
    assert cap_band(MID_CAP_FLOOR_MINOR - 1) == "small"


def test_an_empty_mandate_limits_nothing() -> None:
    assert mandate_brief(Mandate()) is None
    assert universe_problems(Mandate(), "CCJ", URANIUM_MINER) == []
    assert size_problems(Mandate(), _buy(1_000, 10_000), _book(0)) == []


def test_a_blocked_symbol_is_refused_before_anything_else() -> None:
    problems = universe_problems(Mandate(blocked_symbols=("CCJ",)), "CCJ", URANIUM_MINER)
    assert problems == ["CCJ is on this agent's blocked list"]


def test_the_etf_ban_refuses_etfs_only() -> None:
    mandate = Mandate(allow_etfs=False)
    assert universe_problems(mandate, "GDX", GOLD_MINERS_ETF)
    assert universe_problems(mandate, "CCJ", URANIUM_MINER) == []


def test_market_caps_apply_to_equities_and_an_unsized_one_is_not_assumed_to_fit() -> None:
    assert universe_problems(Mandate(market_caps=("large",)), "CCJ", URANIUM_MINER) == []
    assert universe_problems(Mandate(market_caps=("small",)), "CCJ", URANIUM_MINER)
    unsized = _Profile("equity", "Energy", "Uranium", None, None, None)
    assert universe_problems(Mandate(market_caps=("small",)), "X", unsized)
    # An ETF has no market cap; the cap filter is not about funds.
    assert universe_problems(Mandate(market_caps=("small",)), "GDX", GOLD_MINERS_ETF) == []


@pytest.mark.parametrize(
    ("mandate", "inside"),
    [
        (Mandate(sectors=("Energy",)), True),
        (Mandate(industries=("Uranium",)), True),
        (Mandate(sectors=("Technology",)), False),
        (Mandate(etf_categories=("Large Blend",)), False),
    ],
)
def test_an_equity_is_inside_by_its_sector_or_its_industry(mandate: Mandate, inside: bool) -> None:
    assert (universe_problems(mandate, "CCJ", URANIUM_MINER) == []) is inside


def test_a_sector_etf_is_inside_its_mapped_sector_and_a_broad_one_only_by_category() -> None:
    assert universe_problems(Mandate(sectors=("Basic Materials",)), "GDX", GOLD_MINERS_ETF) == []
    assert universe_problems(Mandate(sectors=("Basic Materials",)), "VOO", BROAD_ETF)
    assert universe_problems(Mandate(etf_categories=("Large Blend",)), "VOO", BROAD_ETF) == []


def test_a_position_exactly_at_its_limit_is_allowed_and_one_cent_over_is_not() -> None:
    mandate = Mandate(max_position_bps=1000)
    # Capital 10,000.00 in cash: the limit is 1,000.00 at cost.
    assert size_problems(mandate, _buy(10, 10_000), _book(1_000_000)) == []
    assert size_problems(mandate, _buy(1, 100_001), _book(1_000_000))


def test_the_position_limit_counts_what_is_already_held_at_cost() -> None:
    mandate = Mandate(max_position_bps=1000)
    # 900.00 of CCJ held, 9,100.00 cash: capital 10,000.00; 200.00 more would be 1,100.00.
    problems = size_problems(mandate, _buy(2, 10_000), _book(910_000, {"CCJ": 90_000}))
    assert problems and "over the 10% position limit" in problems[0]


def test_the_cash_buffer_counts_the_fee() -> None:
    mandate = Mandate(cash_buffer_bps=2000)
    # Capital 10,000.00; cash must stay at or above 2,000.00 after notional and fee.
    room = 800_000 - fee_minor(Decimal(1))
    assert size_problems(mandate, _buy(1, room), _book(1_000_000)) == []
    assert size_problems(mandate, _buy(1, room + 1), _book(1_000_000))


def test_max_holdings_refuses_a_new_name_but_not_adding_to_one_held() -> None:
    mandate = Mandate(max_holdings=2)
    full = _book(1_000_000, {"CCJ": 10_000, "XOM": 10_000}, symbol="NEM")
    assert size_problems(mandate, _buy(1, 1_000, "NEM"), full)
    held = _book(1_000_000, {"CCJ": 10_000, "XOM": 10_000}, symbol="CCJ")
    assert size_problems(mandate, _buy(1, 1_000, "CCJ"), held) == []


def test_the_briefing_states_limits_as_percentages_of_capital() -> None:
    brief = mandate_brief(
        Mandate(max_position_bps=1250, cash_buffer_bps=500, allow_etfs=False, sectors=("Energy",))
    )
    assert brief == {
        "max_position_pct_of_capital": "12.5",
        "min_cash_pct_of_capital": "5",
        "etfs_allowed": False,
        "sectors": ["Energy"],
    }
