"""A research rating's checks: the form, the wording and the figures (D254, D292)."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

from app.research.rating import (
    MAX_FINDINGS,
    MAX_RATIONALE_CHARS,
    RATINGS,
    UNSOURCED_PREFIX,
    WORDING_PREFIX,
    forbidden_words,
    parse_rating,
    rating_problems,
)

MIGRATION = Path(__file__).parent.parent / "alembic" / "versions" / "0070_holding_research.py"
EVIDENCE = {
    "symbol": "CCJ",
    "quote": {"price": "54.32", "day_change_percent": 1.5},
    "price_history": {"change_percent": {"20d": "6.10"}},
}


def _answer(**fields: object) -> str:
    return json.dumps({"rating": "bullish", "rationale": "Momentum is firm.", **fields})


def test_ratings_are_the_migrations() -> None:
    spec = importlib.util.spec_from_file_location("m0070", MIGRATION)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert tuple(module.RATINGS) == RATINGS


def test_a_well_formed_answer_parses() -> None:
    parsed, problems = parse_rating(
        "```json\n" + _answer(rating="Neutral", findings=[" A finding. "]) + "\n```"
    )
    assert problems == []
    assert parsed is not None
    assert (parsed.rating, parsed.findings) == ("neutral", ("A finding.",))


@pytest.mark.parametrize(
    ("raw", "problem"),
    [
        ("not json", "the answer is not a JSON object"),
        ("[1]", "the answer is not a JSON object"),
        (_answer(rating="strong buy"), "rating is one of bullish, bearish or neutral"),
        (_answer(rationale=" "), "the rationale says why"),
        (
            _answer(rationale="x" * (MAX_RATIONALE_CHARS + 1)),
            f"the rationale is at most {MAX_RATIONALE_CHARS} characters",
        ),
        (_answer(findings="one"), "findings is a list of short sentences"),
        (_answer(findings=["f"] * (MAX_FINDINGS + 1)), f"at most {MAX_FINDINGS} findings"),
    ],
)
def test_a_malformed_answer_says_why(raw: str, problem: str) -> None:
    parsed, problems = parse_rating(raw)
    assert parsed is None
    assert problem in problems


@pytest.mark.parametrize(
    "sentence",
    [
        "You may like it.",
        "Your exposure grows.",
        "Analysts say Buy.",
        "Investors are selling.",
        "A reason to hold.",
        "The holdings look concentrated.",
        "Time to trim.",
        "Funds kept accumulating.",
        "The price target rose.",
    ],
)
def test_the_wording_never_instructs(sentence: str) -> None:
    assert forbidden_words(sentence), sentence


@pytest.mark.parametrize(
    "sentence",
    ["Household demand is steady.", "Sellside notes are mixed.", "Its outlook is improving."],
)
def test_whole_words_only(sentence: str) -> None:
    assert forbidden_words(sentence) == []


def test_a_rating_with_forbidden_words_or_unsourced_figures_is_refused() -> None:
    parsed, _ = parse_rating(
        _answer(
            rationale="CCJ trades at 54.32 and rose 6.10% in 20 days; buy it.",
            findings=["Revenue grew 40%."],
        )
    )
    assert parsed is not None
    problems = rating_problems(parsed, EVIDENCE)
    assert problems == [f"{WORDING_PREFIX}: buy", f"{UNSOURCED_PREFIX}: 40"]


def test_a_sourced_observation_passes() -> None:
    parsed, _ = parse_rating(
        _answer(rationale="CCJ trades at 54.32 after a 6.10% rise over 20 days.")
    )
    assert parsed is not None
    assert rating_problems(parsed, EVIDENCE) == []
