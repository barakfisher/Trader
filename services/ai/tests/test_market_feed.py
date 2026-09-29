"""The market feed's filter and its outlet lists (decision 60).

What is pinned: an article is market news only when GDELT tagged it *and* the
headline is worded as market news; phrases match only as phrases; listed
outlets are recognised however GDELT spells them; and the suspected-network
check reports an unlisted outlet only past both of its bars. The headlines are
the kinds met in the measured week (2026-09-22..29).
"""

from __future__ import annotations

import pytest

from app.news.market_feed import (
    EXCLUDED_OUTLETS,
    PRESS_RELEASE_WIRES,
    SUSPECT_MIN_HEADLINES,
    SUSPECT_SHARE,
    TICKER_NETWORKS,
    is_excluded_outlet,
    is_market_headline,
    suspected_networks,
)

MARKET = {"ECON_STOCKMARKET", "TAX_FNCACT_INVESTOR"}
OTHER = {"WB_1406_DISEASES"}


def test_tagged_and_worded_is_market_news() -> None:
    assert is_market_headline("Mortgage rates top 7% as the housing market tilts", MARKET)


def test_worded_but_untagged_is_not() -> None:
    assert not is_market_headline("MasterChef star shares her secret recipe", OTHER)


def test_tagged_but_not_worded_is_not() -> None:
    assert not is_market_headline("Wonka just released four limited-edition treats", MARKET)


@pytest.mark.parametrize(
    "title",
    ["AI data centers strain the grid", "Europe's data centre boom", "Rate hike bets rise"],
)
def test_a_market_phrase_counts_with_its_plural(title: str) -> None:
    assert is_market_headline(title, MARKET)


@pytest.mark.parametrize(
    "title",
    ["Street party closes the high street", "Rated best pizza in town", "Goldsmith opens shop"],
)
def test_a_phrase_word_alone_or_a_word_inside_another_is_not(title: str) -> None:
    assert not is_market_headline(title, MARKET)


def test_the_index_name_with_an_ampersand_is_a_word() -> None:
    assert is_market_headline("S&P 500 ends flat", MARKET)


@pytest.mark.parametrize(
    "source", ["tickerreport.com", "WWW.PRNEWSWIRE.COM", " dailypolitical.com "]
)
def test_listed_outlets_are_recognised_however_spelled(source: str) -> None:
    assert is_excluded_outlet(source)


def test_a_real_newsroom_is_not_excluded() -> None:
    assert not is_excluded_outlet("seekingalpha.com")


def test_the_excluded_outlets_are_both_lists() -> None:
    assert EXCLUDED_OUTLETS == TICKER_NETWORKS | PRESS_RELEASE_WIRES


def _outlet(source: str, total: int, templated: int) -> list[tuple[str, str]]:
    return [
        (source, f"Acme Corp (ACME{i}) Shares Up" if i < templated else f"Acme story {i}")
        for i in range(total)
    ]


def test_an_unlisted_outlet_past_both_bars_is_suspected() -> None:
    templated = int(SUSPECT_MIN_HEADLINES * SUSPECT_SHARE) + 1
    (found,) = suspected_networks(_outlet("newnetwork.example", SUSPECT_MIN_HEADLINES, templated))
    assert (found.source, found.headlines, found.templated) == (
        "newnetwork.example",
        SUSPECT_MIN_HEADLINES,
        templated,
    )


def test_too_few_headlines_say_nothing_whatever_the_share() -> None:
    few = SUSPECT_MIN_HEADLINES - 1
    assert suspected_networks(_outlet("small.example", few, few)) == []


def test_a_newsroom_that_names_tickers_often_is_not_suspected() -> None:
    below = int(SUSPECT_MIN_HEADLINES * SUSPECT_SHARE) - 1
    assert suspected_networks(_outlet("newsroom.example", SUSPECT_MIN_HEADLINES, below)) == []


def test_a_listed_network_is_not_reported_again() -> None:
    rows = _outlet("tickerreport.com", SUSPECT_MIN_HEADLINES, SUSPECT_MIN_HEADLINES)
    assert suspected_networks(rows) == []


def test_the_exchange_prefixed_ticker_counts_as_a_template() -> None:
    rows = [("x.example", f"Bloom Energy (NYSE:BE{i}) rating reaffirmed") for i in range(30)]
    assert [s.source for s in suspected_networks(rows)] == ["x.example"]
