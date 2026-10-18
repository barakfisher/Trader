"""The ETF category map must classify every category the committed universe holds (D155).

A category the map has never seen is stored with no sector and a "Technology
only" agent then never meets that category's funds - quietly, because nothing
about a missing row looks wrong. So each category in the committed snapshot
must be either mapped to a sector or listed as having none, and never both:
the second list is what makes "looked at and left without a sector"
distinguishable from "never looked at".
"""

from __future__ import annotations

import json
from pathlib import Path

from app.universe.taxonomy import ETF_CATEGORY_SECTORS, NO_SECTOR_CATEGORIES, SECTORS

REPO_ROOT = Path(__file__).resolve().parents[3]
INSTRUMENTS = REPO_ROOT / "data" / "universe" / "instruments.jsonl"


def _committed(field: str) -> set[str]:
    with INSTRUMENTS.open(encoding="utf-8") as lines:
        values = {json.loads(line).get(field) for line in lines if line.strip()}
    return {value for value in values if value}


def test_every_committed_category_is_classified() -> None:
    unclassified = _committed("category") - set(ETF_CATEGORY_SECTORS) - NO_SECTOR_CATEGORIES
    assert not unclassified, f"map these ETF categories or list them as sectorless: {unclassified}"


def test_no_category_is_both_mapped_and_sectorless() -> None:
    assert not set(ETF_CATEGORY_SECTORS) & NO_SECTOR_CATEGORIES


def test_categories_map_onto_the_equity_sectors() -> None:
    assert set(ETF_CATEGORY_SECTORS.values()) <= SECTORS


def test_the_equity_sectors_are_the_ones_the_universe_holds() -> None:
    assert _committed("sector") == SECTORS
