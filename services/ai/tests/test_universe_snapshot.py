"""Membership rules for the topic universe (`app/universe/snapshot.py`).

The rows below are copied from a real Yahoo screener response (2026-09-24),
trimmed to the keys the rules read. Not invented: MEMORY.md records a template
tested against hand-written evidence that raised `KeyError` on the first real
scan, and a screener row is exactly the kind of payload whose shape is easy to
believe and wrong to assume.
"""

from __future__ import annotations

import json
from pathlib import Path

from app.universe.snapshot import (
    DESCRIPTIONS_FILE,
    MANIFEST_FILE,
    MEMBERSHIP_FILE,
    is_preferred,
    load_snapshot,
    select,
    to_instrument,
)

GOOG = {
    "symbol": "GOOG",
    "longName": "Alphabet Inc.",
    "quoteType": "EQUITY",
    "exchange": "NMS",
    "currency": "USD",
    "marketCap": 4096783810560,
    "averageDailyVolume3Month": 19612403,
}
GOOGL = {
    **GOOG,
    "symbol": "GOOGL",
    "marketCap": 4131638738944,
    "averageDailyVolume3Month": 29401207,
}
JPM = {
    "symbol": "JPM",
    "longName": "JPMorgan Chase & Co.",
    "quoteType": "EQUITY",
    "exchange": "NYQ",
    "currency": "USD",
    "marketCap": 897217593344,
    "averageDailyVolume3Month": 7898917,
}
JPM_PC = {**JPM, "symbol": "JPM-PC", "averageDailyVolume3Month": 185005}
del JPM_PC["marketCap"]
URA = {
    "symbol": "URA",
    "longName": "Global X Uranium ETF",
    "quoteType": "ETF",
    "exchange": "PCX",
    "currency": "USD",
    "netAssets": 6418248700.0,
    "averageDailyVolume3Month": 3141484,
}


def test_preferred_series_are_recognised_and_common_shares_are_not() -> None:
    assert is_preferred("JPM-PC")
    assert is_preferred("PSA-PK")
    assert not is_preferred("JPM")
    assert not is_preferred("BRK-B")
    assert not is_preferred("PBR-A")


def test_select_keeps_one_listing_per_company_the_most_traded() -> None:
    chosen = [q["symbol"] for q in select([GOOG, GOOGL, JPM, JPM_PC, URA])]

    assert chosen == ["GOOGL", "JPM", "URA"]


def test_the_most_traded_listing_wins_whatever_the_input_order() -> None:
    assert [q["symbol"] for q in select([GOOGL, GOOG])] == ["GOOGL"]


def test_unnamed_rows_are_not_merged_into_one() -> None:
    a = {"symbol": "AAA", "exchange": "NYQ"}
    b = {"symbol": "BBB", "exchange": "NYQ"}

    assert [q["symbol"] for q in select([a, b])] == ["AAA", "BBB"]


def test_an_equity_carries_market_cap_in_minor_units_and_no_net_assets() -> None:
    row = to_instrument(GOOGL, {"sector": "Communication Services", "longBusinessSummary": " x "})

    assert row.asset_class == "equity"
    assert row.market_cap_minor == 4131638738944 * 100
    assert row.net_assets_minor is None
    assert row.description == "x"


def test_an_etf_carries_net_assets_and_no_market_cap() -> None:
    row = to_instrument(URA, {"category": "Natural Resources"})

    assert row.asset_class == "etf"
    assert row.net_assets_minor == 641824870000
    assert row.market_cap_minor is None
    assert row.category == "Natural Resources"


def test_a_missing_size_or_description_is_null_never_zero_or_empty() -> None:
    row = to_instrument(JPM_PC, {"longBusinessSummary": "   "})

    assert row.market_cap_minor is None
    assert row.description is None


def test_membership_json_never_carries_the_description() -> None:
    row = to_instrument(GOOGL, {"longBusinessSummary": "Yahoo's prose"})

    assert "description" not in row.membership_json()


def test_load_snapshot_joins_local_descriptions_and_keeps_undescribed_members(
    tmp_path: Path,
) -> None:
    googl = to_instrument(GOOGL, {"longBusinessSummary": "Search and cloud."})
    ura = to_instrument(URA, {})
    (tmp_path / MANIFEST_FILE).write_text(json.dumps({"as_of": "2026-09-24T12:00:00Z"}))
    (tmp_path / MEMBERSHIP_FILE).write_text(
        "\n".join(json.dumps(i.membership_json()) for i in (googl, ura)) + "\n"
    )
    (tmp_path / DESCRIPTIONS_FILE).write_text(
        json.dumps({"symbol": "GOOGL", "description": "Search and cloud."}) + "\n"
    )

    snapshot = load_snapshot(tmp_path)

    assert snapshot.as_of == "2026-09-24T12:00:00Z"
    assert snapshot.instruments == [googl, ura]
    assert snapshot.instruments[1].description is None


def test_load_snapshot_without_a_descriptions_file_describes_nothing(tmp_path: Path) -> None:
    (tmp_path / MANIFEST_FILE).write_text(json.dumps({"as_of": "2026-09-24T12:00:00Z"}))
    (tmp_path / MEMBERSHIP_FILE).write_text(
        json.dumps(to_instrument(URA, {}).membership_json()) + "\n"
    )

    assert [i.description for i in load_snapshot(tmp_path).instruments] == [None]
