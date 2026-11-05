"""A research rating's checks: the form and the figures (D254, D292, D392)."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

from app.research.rating import (
    ACTIONABLE_RATINGS,
    HELD_RATINGS,
    LEGACY_RATINGS,
    MAX_FINDINGS,
    MAX_RATIONALE_CHARS,
    RATINGS,
    UNHELD_RATINGS,
    UNSOURCED_PREFIX,
    parse_rating,
    rating_problems,
)

MIGRATION = Path(__file__).parent.parent / "alembic" / "versions" / "0085_research_advice.py"
EVIDENCE = {
    "symbol": "CCJ",
    "quote": {"price": "54.32", "day_change_percent": 1.5},
    "price_history": {"change_percent": {"20d": "6.10"}},
}


def _answer(**fields: object) -> str:
    return json.dumps({"rating": "hold", "rationale": "Momentum is firm.", **fields})


def test_ratings_are_the_migrations() -> None:
    spec = importlib.util.spec_from_file_location("m0085", MIGRATION)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert tuple(module.RATINGS) == RATINGS


def test_a_well_formed_answer_parses() -> None:
    parsed, problems = parse_rating(
        "```json\n" + _answer(rating="Buy more", findings=[" A finding. "]) + "\n```",
        held=True,
    )
    assert problems == []
    assert parsed is not None
    assert (parsed.rating, parsed.findings) == ("buy_more", ("A finding.",))


def test_each_vocabulary_is_its_own() -> None:
    """A held stock is never rated "buy", one not held never "trim" (D392)."""
    for rating in HELD_RATINGS:
        assert parse_rating(_answer(rating=rating), held=True)[0] is not None
        assert parse_rating(_answer(rating=rating), held=False)[0] is None
    for rating in UNHELD_RATINGS:
        assert parse_rating(_answer(rating=rating), held=False)[0] is not None
        assert parse_rating(_answer(rating=rating), held=True)[0] is None


def test_a_legacy_word_is_stored_but_never_answered() -> None:
    for rating in LEGACY_RATINGS:
        assert rating in RATINGS
        assert parse_rating(_answer(rating=rating), held=True)[0] is None


def test_hold_wait_and_avoid_raise_nothing() -> None:
    assert {"hold", "wait", "avoid"}.isdisjoint(ACTIONABLE_RATINGS)
    assert set(ACTIONABLE_RATINGS) <= set(HELD_RATINGS) | set(UNHELD_RATINGS)


@pytest.mark.parametrize(
    ("raw", "problem"),
    [
        ("not json", "the answer is not a JSON object"),
        ("[1]", "the answer is not a JSON object"),
        (_answer(rating="strong buy"), "rating is one of buy_more, hold, trim, sell"),
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
    parsed, problems = parse_rating(raw, held=True)
    assert parsed is None
    assert problem in problems


def test_advice_wording_passes_and_unsourced_figures_are_refused() -> None:
    """D254 guardrail 1 is gone (D392): "you" and "trim" pass; guardrail 2 stays."""
    parsed, _ = parse_rating(
        _answer(
            rating="trim",
            rationale="CCJ trades at 54.32 and rose 6.10% in 20 days; you could trim it.",
            findings=["Revenue grew 40%."],
        ),
        held=True,
    )
    assert parsed is not None
    assert rating_problems(parsed, EVIDENCE) == [f"{UNSOURCED_PREFIX}: 40"]


def test_figures_are_checked_in_hebrew_too() -> None:
    parsed, _ = parse_rating(
        _answer(rationale="המניה נסחרת ב-54.32 אחרי עלייה של 6.10% במשך 20 ימים, ולא 71."),
        held=True,
    )
    assert parsed is not None
    assert rating_problems(parsed, EVIDENCE) == [f"{UNSOURCED_PREFIX}: 71"]


def test_a_sourced_observation_passes() -> None:
    parsed, _ = parse_rating(
        _answer(rationale="CCJ trades at 54.32 after a 6.10% rise over 20 days."), held=True
    )
    assert parsed is not None
    assert rating_problems(parsed, EVIDENCE) == []
