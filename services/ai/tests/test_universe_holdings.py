"""Matching an ETF holding, as Yahoo writes it, to a US listing in the universe.

The cases are the ones the M5 slice 2 probe met in real holdings data: Cameco
written as `CCO.TO` (URA's largest position), TSMC as `2330.TW`, Kazatomprom as
`KAP`, and NVIDIA written plainly.
"""

from __future__ import annotations

from app.universe.profiles import HoldingMatcher, Member

CAMECO = Member("1", "CCJ", "Cameco Corporation")
TSMC = Member("2", "TSM", "Taiwan Semiconductor Manufacturing Company Limited")
NVIDIA = Member("3", "NVDA", "NVIDIA Corporation")
KAP_US = Member("4", "KAP", "Kapstone Something Inc.")  # an unrelated US "KAP"
MATCHER = HoldingMatcher([CAMECO, TSMC, NVIDIA, KAP_US])


def test_a_us_symbol_with_an_agreeing_name_matches_by_symbol() -> None:
    assert MATCHER.match("NVDA", "NVIDIA Corp") == (NVIDIA, "symbol")


def test_a_foreign_listing_matches_its_us_listing_by_core_name() -> None:
    assert MATCHER.match("CCO.TO", "Cameco Corp") == (CAMECO, "name")
    assert MATCHER.match("2330.TW", "Taiwan Semiconductor Manufacturing Co Ltd") == (
        TSMC,
        "name",
    )


def test_a_coincident_symbol_with_a_different_company_is_not_taken() -> None:
    assert MATCHER.match("KAP", "NAC Kazatomprom JSC") is None


def test_an_unknown_company_matches_nothing() -> None:
    assert MATCHER.match("RHM.DE", "Rheinmetall AG") is None


def test_a_name_shared_by_two_members_is_not_guessed() -> None:
    twins = HoldingMatcher([Member("a", "AAA", "Twin Corp"), Member("b", "BBB", "Twin Inc")])

    assert twins.match("TWN.L", "Twin plc") is None


def test_a_symbol_match_needs_no_name_when_none_is_given() -> None:
    assert MATCHER.match("NVDA", None) == (NVIDIA, "symbol")


def test_only_a_fraction_of_the_fund_is_a_plausible_weight() -> None:
    from app.universe.profiles import plausible_weight

    assert plausible_weight("0.2262")
    assert plausible_weight("1")
    assert not plausible_weight("0.0")  # a cash placeholder
    assert not plausible_weight("1.0622402")  # a wrapper holding another ETF
    assert not plausible_weight("668.8027")  # a reporting error
    assert not plausible_weight("n/a")


def test_group_is_part_of_a_name_not_a_legal_form() -> None:
    compass = HoldingMatcher(
        [Member("c", "COMP", "Compass, Inc."), Member("a", "APA", "APA Corporation")]
    )

    assert compass.match("CPG.L", "Compass Group PLC") is None
    assert compass.match("APA.AX", "APA Group") is None


def test_a_group_name_still_matches_the_same_group() -> None:
    mufg = HoldingMatcher([Member("m", "MUFG", "Mitsubishi UFJ Financial Group, Inc.")])

    assert mufg.match("8306.T", "Mitsubishi UFJ Financial Group Inc") == (
        Member("m", "MUFG", "Mitsubishi UFJ Financial Group, Inc."),
        "name",
    )
