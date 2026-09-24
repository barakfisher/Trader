"""Where a question goes, and whether the corpus is judged to cover it.

Both modules here are pure, which is why they are separated from the service at
all: routing and refusing are the two decisions where being subtly wrong looks
exactly like working, and both can be pinned without a database or a key.

The counter-examples matter more than the positives. `test_first_person_is_not_a
_portfolio_question` is the one that would have shipped: every obvious
implementation of intent routing keys on "my" and "I", and the question that
motivated this whole milestone - "how much did I lose from the top" - is
first-person and is about drawdown.
"""

from __future__ import annotations

import pytest

from app.ask.intent import Intent, classify
from app.ask.relevance import CONFIDENT_ABOVE, REFUSE_BELOW, Relevance, judge

# --------------------------------------------------------------------------
# Intent
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "question",
    [
        "how much did I lose from the top",
        "should I sell when things drop",
        "did I miss something important",
        "is this a big move or normal noise",
    ],
)
def test_first_person_is_not_a_portfolio_question(question: str) -> None:
    """The bug every obvious implementation of this ships with.

    Pronouns say how somebody writes, not what they are asking about. Each of
    these is answered correctly from the corpus, and routing them to the
    arithmetic path would return figures about their holdings as if those were
    the answer.
    """
    assert classify(question) is Intent.CONCEPT


@pytest.mark.parametrize(
    "question",
    [
        "what is my portfolio worth",
        "what is my largest position",
        "how far are my weights from my targets",
        "do I have any tech exposure",
        "what do I own",
    ],
)
def test_a_reference_to_their_holdings_is_a_portfolio_question(question: str) -> None:
    assert classify(question) is Intent.PORTFOLIO


def test_a_definition_request_outranks_a_possessive() -> None:
    """They are asking what a word means and naming their portfolio as setting."""
    assert classify("what does overweight mean for my portfolio") is Intent.CONCEPT


def test_a_symbol_routes_to_portfolio_only_when_they_hold_it() -> None:
    """Otherwise a corpus example mentioning a ticker would hijack a definition."""
    assert classify("how much AAPL do I have", symbols=("AAPL",)) is Intent.PORTFOLIO
    assert classify("what is a drawdown", symbols=("AAPL",)) is Intent.CONCEPT


def test_a_symbol_matches_on_word_boundaries() -> None:
    """`SO` is a real ticker, and `so` is a very common word."""
    assert classify("so what is volatility", symbols=("SO",)) is Intent.CONCEPT


def test_ambiguity_resolves_to_concept() -> None:
    """The harmless direction: a definition nobody wanted is obviously useless.

    The other way round returns numbers about someone's money in answer to a
    question that was not about them, which reads like an answer.
    """
    assert classify("what about rebalancing") is Intent.CONCEPT


# --------------------------------------------------------------------------
# Relevance
# --------------------------------------------------------------------------


def test_a_clearly_unrelated_question_is_refused() -> None:
    verdict = judge(0.05, vector_is_semantic=True)

    assert verdict.relevance is Relevance.NONE
    assert verdict.is_answerable is False


def test_a_direct_term_question_is_confident() -> None:
    verdict = judge(0.71, vector_is_semantic=True)

    assert verdict.relevance is Relevance.CONFIDENT


def test_a_paraphrase_is_answered_but_labelled_weak() -> None:
    """The measurement supported three states and not two - see relevance.py.

    Separation between in-domain and out-of-domain was 0.0289 over sixteen
    questions. A binary would put a coin flip behind a boolean and report it as
    a decision.
    """
    verdict = judge((REFUSE_BELOW + CONFIDENT_ABOVE) / 2, vector_is_semantic=True)

    assert verdict.relevance is Relevance.WEAK
    assert verdict.is_answerable is True


def test_the_bands_are_expressed_through_the_constants() -> None:
    """Per CLAUDE.md: assert the constant, never its current value.

    Retuning the floor on slice 4's evidence must not break a test about which
    band a score falls in.
    """
    assert judge(REFUSE_BELOW, vector_is_semantic=True).relevance is Relevance.WEAK
    assert judge(CONFIDENT_ABOVE, vector_is_semantic=True).relevance is Relevance.CONFIDENT


def test_the_floor_abstains_entirely_for_a_placeholder_embedder() -> None:
    """The case CI runs in, and the one where a threshold would be theatre.

    The fixture embedder's similarities measure shared words, so they are not on
    the scale these thresholds were measured against. Applying the floor to them
    would refuse or admit essentially at random while looking like a considered
    decision.
    """
    assert judge(0.01, vector_is_semantic=False).relevance is Relevance.WEAK
    assert judge(0.99, vector_is_semantic=False).relevance is Relevance.WEAK


def test_no_vector_match_at_all_is_not_evidence_of_irrelevance() -> None:
    """An un-embedded corpus must not be reported as "we do not cover that".

    Absence of evidence and evidence of absence produce the same silence and
    must not produce the same answer.
    """
    verdict = judge(None, vector_is_semantic=True)

    assert verdict.relevance is Relevance.WEAK
    assert verdict.is_answerable is True


def test_the_judgement_carries_the_thresholds_it_was_judged_by() -> None:
    """So a stored answer stays explicable after the constants change."""
    verdict = judge(0.5, vector_is_semantic=True)

    assert verdict.refuse_below == REFUSE_BELOW
    assert verdict.confident_above == CONFIDENT_ABOVE
