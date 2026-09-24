"""Arithmetic over someone's holdings, and what it refuses to pretend.

The figures are checked against hand-computed values rather than against what
the code produces, because a test that asserts the implementation's own output
proves only that it is deterministic.

The unpriced holding is in almost every case on purpose. A position the
orchestrator could not value is the single most likely thing to be silently
dropped - it is `None`, it breaks a `sum`, and the obvious fix is to skip it.
Skipping it produces a portfolio total that is a true fact about a subset nobody
chose, presented as a fact about the portfolio. Guideline 14 exists for exactly
this, and these tests are what stop the obvious fix.
"""

from __future__ import annotations

from decimal import Decimal

from app.ask.portfolio import (
    Position,
    drift_against_targets,
    extreme_position,
    position_weight,
    total_value,
)
from app.ask.service import answer_portfolio_question
from app.narration.evidence_validator import is_supported

# 12,500 + 4,800 + 3,200 = 20,500.00 USD priced, plus one that could not be valued.
HOLDINGS = [
    Position("VOO", 1_250_000, "USD"),
    Position("AAPL", 480_000, "USD"),
    Position("MSFT", 320_000, "USD"),
    Position("XYZ", None, "USD"),
]
TARGETS = {"VOO": "0.50", "AAPL": "0.30", "MSFT": "0.20"}


def test_the_total_is_the_priced_sum_and_says_what_it_left_out() -> None:
    result = total_value(HOLDINGS, "USD")

    assert result is not None
    assert result.evidence["total_value_minor"] == 2_050_000
    assert "20500.00 USD" in result.text
    # The sentence that stops a partial total reading as a whole one.
    assert "1 unpriced holding" in result.text
    assert result.evidence["priced_count"] == 3
    assert result.evidence["holdings_count"] == 4


def test_every_figure_in_a_portfolio_answer_is_in_its_evidence() -> None:
    """The same check narration's output has to pass.

    It is applied here because these sentences are about someone's money, and a
    figure in the text that is not in the evidence is one nobody can check.
    """
    for result in (
        total_value(HOLDINGS, "USD"),
        extreme_position(HOLDINGS, "USD", largest=True),
        position_weight(HOLDINGS, "USD", symbol="AAPL"),
        drift_against_targets(HOLDINGS, "USD", targets=TARGETS),
    ):
        assert result is not None
        assert is_supported(result.text, result.evidence), result.text


def test_weights_are_computed_over_the_priced_subset() -> None:
    """1,250,000 / 2,050,000 = 60.98%, not 1,250,000 over an unknown total."""
    result = extreme_position(HOLDINGS, "USD", largest=True)

    assert result is not None
    assert result.evidence["symbol"] == "VOO"
    assert Decimal(str(result.evidence["weight"])) == Decimal("0.6098")
    assert "61.0%" in result.text


def test_the_smallest_position_ignores_the_unpriced_one() -> None:
    """Unpriced is not zero, so it cannot be the smallest (guideline 14)."""
    result = extreme_position(HOLDINGS, "USD", largest=False)

    assert result is not None
    assert result.evidence["symbol"] == "MSFT"


def test_a_held_but_unpriced_position_is_answered_as_unknown() -> None:
    """Three different things - not held, held and unpriced, held and worth 0.

    A zero here would render an infrastructure failure as a financial fact.
    """
    result = position_weight(HOLDINGS, "USD", symbol="XYZ")

    assert result is not None
    assert result.evidence["value_minor"] is None
    assert "could not be priced" in result.text
    assert "0" not in result.text.split("could not be priced")[0]


def test_a_position_they_do_not_hold_has_no_answer() -> None:
    assert position_weight(HOLDINGS, "USD", symbol="TSLA") is None


def test_drift_reports_the_furthest_holding_from_its_target() -> None:
    """VOO is 60.98% against a 50% target: 10.98pp, the largest gap."""
    result = drift_against_targets(HOLDINGS, "USD", targets=TARGETS)

    assert result is not None
    assert result.evidence["symbol"] == "VOO"
    assert Decimal(str(result.evidence["drift"])) == Decimal("0.1098")
    assert "above" in result.text


def test_a_portfolio_with_nothing_priced_has_no_total() -> None:
    """Better than a confident 0.00, which is what summing Nones would give."""
    assert total_value([Position("A", None), Position("B", None)], "USD") is None


def test_concept_refs_only_name_documents_that_exist() -> None:
    """A chip pointing at nothing is the dead label FR-16 exists to remove.

    Read from the corpus directory rather than from a hard-coded list, so adding
    a slug here without writing the document fails - the same contract
    `test_concept_corpus_contract.py` enforces for narration templates.
    """
    from pathlib import Path

    corpus = Path(__file__).resolve().parents[3] / "data" / "corpus" / "concepts"
    available = {path.stem for path in corpus.glob("*.md")}
    assert available, "corpus directory not found"

    for result in (
        total_value(HOLDINGS, "USD"),
        extreme_position(HOLDINGS, "USD", largest=True),
        position_weight(HOLDINGS, "USD", symbol="AAPL"),
        position_weight(HOLDINGS, "USD", symbol="XYZ"),
        drift_against_targets(HOLDINGS, "USD", targets=TARGETS),
    ):
        assert result is not None
        unknown = set(result.concept_refs) - available
        assert not unknown, f"no document for {unknown}"


# --------------------------------------------------------------------------
# The three ways of declining, which are not the same
# --------------------------------------------------------------------------


def test_a_portfolio_question_with_no_holdings_blames_the_caller_not_the_corpus() -> None:
    """ "Your portfolio did not load" and "we do not cover that" are different.

    Collapsing them would tell someone their question was out of scope when the
    truth was that the request was missing data.
    """
    result = answer_portfolio_question(question="what is my portfolio worth", positions=[])

    assert result.answered is False
    assert result.refused_reason == "no_holdings"


def test_a_question_outside_the_computable_set_says_what_is_inside_it() -> None:
    """A boundary the reader can learn is worth more than a polite refusal."""
    result = answer_portfolio_question(
        question="what colour should I paint my portfolio", positions=HOLDINGS
    )

    assert result.answered is False
    assert result.refused_reason == "not_computable"
    assert "largest" in result.text


def test_a_portfolio_answer_is_never_attributed_to_a_model() -> None:
    """A model is never asked what a portfolio contains, and the wire says so."""
    result = answer_portfolio_question(question="what is my portfolio worth", positions=HOLDINGS)

    assert result.answered is True
    assert result.answer_source == "computed"


# --------------------------------------------------------------------------
# Questions the arithmetic must refuse even though a handler would match
# --------------------------------------------------------------------------


def test_asking_what_to_do_with_a_holding_is_refused_as_advice() -> None:
    """Guideline 2. Found by the eval set, not by review.

    "should I sell my largest position" names the largest position, so the
    largest-position handler would answer it with that position's value -
    dodging the question silently instead of declining it.
    """
    result = answer_portfolio_question(
        question="should I sell my largest position", positions=HOLDINGS
    )

    assert result.answered is False
    assert result.refused_reason == "advice"
    assert "never gives personal investment advice" in result.text


def test_a_forecast_is_refused_rather_than_answered_with_todays_figure() -> None:
    """Also found by the eval. "worth" matches the total handler.

    Answering "what will it be worth next year" with today's total is answering
    a different question, confidently.
    """
    result = answer_portfolio_question(
        question="what will my portfolio be worth next year", positions=HOLDINGS
    )

    assert result.answered is False
    assert result.refused_reason == "not_computable"


def test_the_refusal_checks_do_not_swallow_ordinary_portfolio_questions() -> None:
    """The markers must be specific enough to leave these alone."""
    for question in ("what is my portfolio worth", "which is my biggest holding"):
        assert answer_portfolio_question(question=question, positions=HOLDINGS).answered, question
