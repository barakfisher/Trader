"""Grouping candidates into meanings, and the gate in front of it, without a database.

Vectors are tiny and hand-placed so each property is visible: two tight clusters
far apart are two meanings; a tight cluster with a loose facet is one.
"""

from __future__ import annotations

import math

from app.topics import resolution
from app.topics.meanings import group, nearest_group
from app.universe.profiles import ProfileMatch


def _unit(*components: float) -> list[float]:
    norm = math.sqrt(sum(c * c for c in components))
    return [c / norm for c in components]


SNACK_A = _unit(1.0, 0.1, 0.0)
SNACK_B = _unit(1.0, 0.0, 0.1)
CHIP_A = _unit(0.0, 1.0, 0.1)
CHIP_B = _unit(0.1, 1.0, 0.0)


def test_two_unrelated_clusters_stay_two_groups() -> None:
    groups = group([SNACK_A, CHIP_A, SNACK_B, CHIP_B], split_below=0.5)

    assert sorted(groups) == [[0, 2], [1, 3]]


def test_a_low_threshold_merges_everything_into_one_meaning() -> None:
    assert group([SNACK_A, CHIP_A, SNACK_B, CHIP_B], split_below=-1.0) == [[0, 1, 2, 3]]


def test_average_linkage_does_not_let_one_bridge_join_two_clusters() -> None:
    bridge = _unit(1.0, 1.0, 0.0)  # close to both clusters, typical of neither
    groups = group([SNACK_A, SNACK_B, CHIP_A, CHIP_B, bridge], split_below=0.8)

    assert [0, 1] in groups or [0, 1, 4] in groups
    assert not any({0, 2} <= set(g) for g in groups)


def test_group_of_nothing_is_nothing() -> None:
    assert group([], split_below=0.5) == []


def test_nearest_group_picks_the_closer_cluster_on_average() -> None:
    vectors = [SNACK_A, SNACK_B, CHIP_A, CHIP_B]

    assert nearest_group(_unit(0.9, 0.2, 0.0), [[0, 1], [2, 3]], vectors) == 0
    assert nearest_group(_unit(0.1, 0.9, 0.0), [[0, 1], [2, 3]], vectors) == 1


def _match(symbol: str, similarity: float, vector: list[float], *, etf: bool = False,
           size: int | None = 100) -> ProfileMatch:  # fmt: skip
    return ProfileMatch(
        instrument_id=symbol,
        symbol=symbol,
        name=symbol,
        asset_class="etf" if etf else "equity",
        sector=None,
        industry=None,
        category=None,
        description=f"{symbol} does things.",
        similarity=similarity,
        size_minor=size,
        size_currency=None if size is None else "USD",
        embedding=vector,
    )


def test_admit_applies_the_band_below_the_best_match() -> None:
    best = 0.60
    matches = [
        _match("A", best, SNACK_A),
        _match("B", best - resolution.BAND, SNACK_B),
        _match("C", best - resolution.BAND - 0.01, CHIP_A),
    ]

    assert [m.symbol for m in resolution.admit(matches)] == ["A", "B"]


def test_admit_applies_the_floor_when_it_is_higher_than_the_band() -> None:
    top = resolution.CANDIDATE_FLOOR + 0.02
    matches = [
        _match("A", top, SNACK_A),
        _match("B", resolution.CANDIDATE_FLOOR, SNACK_B),
        _match("C", resolution.CANDIDATE_FLOOR - 0.01, CHIP_A),
    ]

    assert [m.symbol for m in resolution.admit(matches)] == ["A", "B"]


def test_admit_keeps_at_most_the_cap_most_similar_first() -> None:
    matches = [
        _match(f"S{i}", 0.60 - i * 0.0001, SNACK_A) for i in range(resolution.MAX_ADMITTED + 5)
    ]

    admitted = resolution.admit(matches)

    assert len(admitted) == resolution.MAX_ADMITTED
    assert admitted[0].symbol == "S0"


def test_split_meanings_offers_two_interpretations_and_attaches_etfs() -> None:
    matches = [
        _match("SNK1", 0.50, SNACK_A),
        _match("CHP1", 0.49, CHIP_A),
        _match("SNK2", 0.48, SNACK_B),
        _match("CHP2", 0.47, CHIP_B),
        _match("SMH", 0.46, _unit(0.05, 1.0, 0.05), etf=True),
    ]

    meanings = resolution.split_meanings(matches)

    assert [sorted(m.symbol for m in meaning) for meaning in meanings] == [
        ["SNK1", "SNK2"],
        ["CHP1", "CHP2", "SMH"],
    ]


def test_one_cluster_is_one_interpretation_with_everything_in_it() -> None:
    matches = [
        _match("A", 0.5, SNACK_A),
        _match("B", 0.49, SNACK_B),
        _match("E", 0.4, SNACK_A, etf=True),
    ]

    assert resolution.split_meanings(matches) == [matches]


def test_source_candidates_are_the_closest_etfs_above_the_floor() -> None:
    above = resolution.ETF_SOURCE_FLOOR + 0.05
    matches = [
        _match("STOCK", above + 0.1, SNACK_A),
        *[
            _match(f"ETF{i}", above - i * 0.001, SNACK_A, etf=True)
            for i in range(resolution.ETF_SOURCE_CANDIDATES + 2)
        ],
        _match("FAR", resolution.ETF_SOURCE_FLOOR - 0.01, SNACK_A, etf=True),
    ]

    chosen = [m.symbol for m in resolution.source_candidates(matches)]

    assert chosen == [f"ETF{i}" for i in range(resolution.ETF_SOURCE_CANDIDATES)]


def test_a_fund_whose_holdings_are_off_topic_is_not_a_source() -> None:
    best = 0.50
    thematic = _match("DTCR", 0.44, SNACK_A, etf=True)
    broad = _match("IYR", 0.43, SNACK_A, etf=True)
    empty = _match("USO", 0.42, SNACK_A, etf=True)
    scores = {
        "DTCR": [best - resolution.COHERENCE_BAND + 0.01] * 3,
        "IYR": [best - resolution.COHERENCE_BAND - 0.01] * 3,
    }

    assert resolution.coherent([thematic, broad, empty], scores, best=best) == [thematic]


def test_at_most_the_source_limit_coherent_funds_are_kept_closest_first() -> None:
    funds = [
        _match(f"F{i}", 0.45 - i * 0.001, SNACK_A, etf=True)
        for i in range(resolution.ETF_SOURCES + 2)
    ]
    scores = {f.symbol: [0.5] for f in funds}

    assert resolution.coherent(funds, scores, best=0.5) == funds[: resolution.ETF_SOURCES]


def test_a_candidate_carries_what_confirmation_stores_and_its_currency() -> None:
    sized = _match("NVDA", 0.5, CHIP_A, size=544_540_000_000_000)
    unsized = _match("NEW", 0.49, CHIP_B, size=None)

    interpretation = resolution._interpretation(
        "chips", [sized, unsized], limit=15, semantic=True, held={}
    )

    by_symbol = {c.symbol: c for c in interpretation.candidates}
    assert by_symbol["NVDA"].instrument_id == "NVDA"  # _match uses the symbol as the id
    assert (by_symbol["NVDA"].size_minor, by_symbol["NVDA"].size_currency) == (
        544_540_000_000_000,
        "USD",
    )
    # Unknown size is null with no currency - never a zero, never a stray code.
    assert (by_symbol["NEW"].size_minor, by_symbol["NEW"].size_currency) == (None, None)
    assert [c.symbol for c in interpretation.candidates] == ["NVDA", "NEW"]
