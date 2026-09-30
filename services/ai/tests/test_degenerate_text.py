"""`is_degenerate`: a model looping is caught, and ordinary prose never is."""

from __future__ import annotations

import pytest

from app.llm.degenerate_text import MIN_REPEATS, is_degenerate, repeated_run


@pytest.mark.parametrize(
    "text",
    [
        "Hereellsellsellsellsellsellsellsellsellsellsell deep mass",
        "the the the the the the the the the market",
        "a" * 40,
        "ok " + "drift " * MIN_REPEATS,
    ],
)
def test_a_loop_is_degenerate(text: str) -> None:
    assert is_degenerate(text)


@pytest.mark.parametrize(
    "text",
    [
        "A drawdown is how far an instrument has fallen from a recent high.",
        "Volatility, volatility and more volatility: markets moved a lot this week.",
        "----------------------------------------",
        "1111111111111111 is a number, and ...................... is punctuation",
        "sell " * (MIN_REPEATS - 1),
        "",
    ],
)
def test_prose_and_punctuation_are_not(text: str) -> None:
    assert not is_degenerate(text)


def test_the_run_is_reported_for_the_log() -> None:
    assert repeated_run("x " + "ab" * 12) == "ab" * 12
