"""An instrument's own name is removed from the text a topic is matched against.

Names are the real ones from the measurement that motivated this (Fastenal under
"fast food", Everest Group for "mount everest"); the sentences are written for
the test, since Yahoo's prose does not belong in a committed file.
"""

from __future__ import annotations

from app.universe.matching_text import matching_text


def test_the_full_name_and_the_core_name_are_both_replaced() -> None:
    text = matching_text(
        "Fastenal Company",
        "equity",
        "Fastenal Company distributes fasteners. Fastenal was founded in 1967.",
    )

    assert text == "The company distributes fasteners. The company was founded in 1967."
    assert "fastenal" not in text.lower()


def test_a_legal_suffix_with_punctuation_is_still_found() -> None:
    text = matching_text("Everest Group, Ltd.", "equity", "Everest Group, Ltd. writes reinsurance.")

    assert text == "The company writes reinsurance."


def test_a_topic_word_inside_the_name_survives_elsewhere() -> None:
    # The phrase "Gold Fields" goes; the word "gold" describing the business stays.
    text = matching_text(
        "Gold Fields Limited", "equity", "Gold Fields Limited mines gold in Ghana."
    )

    assert text == "The company mines gold in Ghana."


def test_a_fund_is_called_a_fund() -> None:
    text = matching_text("Global X Uranium ETF", "etf", "Global X Uranium ETF tracks miners.")

    assert text == "The fund tracks miners."


def test_a_name_is_only_replaced_as_a_whole_word() -> None:
    text = matching_text("Visa Inc.", "equity", "Visa runs a network; visas are unrelated.")

    assert text == "The company runs a network; visas are unrelated."


def test_very_short_names_are_left_alone() -> None:
    assert matching_text("X", "equity", "X makes a box. Taxes apply.") == (
        "X makes a box. Taxes apply."
    )


def test_no_name_leaves_the_description_unchanged() -> None:
    assert matching_text(None, "equity", "Makes things.") == "Makes things."
