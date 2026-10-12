"""Whether the corpus is judged to cover a question (`app/corpus/relevance.py`).

Pure, so it is pinned without a database or a key. Topic resolution reads the
same bands (`app/topics/resolution.py`); they were first measured for the
extractive `/ask`, retired once the assistant replaced it (assistant PR 4).
"""

from __future__ import annotations

from app.corpus.relevance import CONFIDENT_ABOVE, REFUSE_BELOW, Relevance, judge


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
