"""A weak match must say so in its text, not only on the wire.

`relevance: weak` was always in the response, but the reply text for a weak
match was identical to a confident one, so a reader who never sees the JSON got
no signal at all. The eval set found the consequence: "what is the current
price of gold" came back as the drawdown formula, stated flatly.

The hedge is applied by the service from the relevance verdict, and these tests
pin that it does not depend on who wrote the body - an extractive reply and a
model-written one are hedged alike, because whether an answer admits
uncertainty must not depend on how a model chose to phrase it.
"""

from __future__ import annotations

import asyncio
import typing

import pytest

from app.ask import service
from app.ask.relevance import CONFIDENT_ABOVE, REFUSE_BELOW
from app.ask.service import WEAK_MATCH_PREFIX, answer_concept_question
from app.corpus.retrieval import HybridResult, ScoredChunk
from app.llm.base import Caller

CHUNK = ScoredChunk(
    chunk_id="c1",
    document_id="d1",
    concept_slug="drawdown",
    title="Drawdown",
    heading="How it is computed",
    ord=2,
    text="Find the highest price inside a lookback window.",
    score=0.03,
    vector_rank=1,
    text_rank=None,
    vector_similarity=0.3,
)


def _run(monkeypatch: pytest.MonkeyPatch, similarity: float, *, llm: object = None) -> object:
    async def fake_search(*_args: object, **_kwargs: object) -> HybridResult:
        return HybridResult(
            query="q",
            chunks=(CHUNK,),
            embedding_model="openai/text-embedding-3-small",
            vector_is_semantic=True,
            best_similarity=similarity,
        )

    monkeypatch.setattr(service, "hybrid_search", fake_search)
    return asyncio.run(
        answer_concept_question(None, None, None, question="q", llm=llm)  # type: ignore[arg-type]
    )


def test_a_weak_match_opens_with_the_caveat(monkeypatch: pytest.MonkeyPatch) -> None:
    weak = (REFUSE_BELOW + CONFIDENT_ABOVE) / 2

    result = _run(monkeypatch, weak)

    assert result.answered is True  # type: ignore[attr-defined]
    assert result.text.startswith(WEAK_MATCH_PREFIX)  # type: ignore[attr-defined]


def test_a_confident_match_is_not_hedged(monkeypatch: pytest.MonkeyPatch) -> None:
    """A caveat on every answer is a caveat nobody reads."""
    result = _run(monkeypatch, CONFIDENT_ABOVE + 0.1)

    assert not result.text.startswith(WEAK_MATCH_PREFIX)  # type: ignore[attr-defined]


def test_a_refusal_is_not_hedged_it_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    result = _run(monkeypatch, REFUSE_BELOW - 0.1)

    assert result.answered is False  # type: ignore[attr-defined]
    assert WEAK_MATCH_PREFIX not in result.text  # type: ignore[attr-defined]


def test_a_model_written_weak_answer_is_hedged_too(monkeypatch: pytest.MonkeyPatch) -> None:
    """The service hedges from the verdict; the model does not get a vote."""

    class Model:
        async def complete(self, **_kwargs: object) -> object:
            class Completion:
                text = "A drawdown compares the latest price with a recent high."
                call_id = None

            return Completion()

        async def record_verdict(self, *_args: object) -> None:
            return None

    result = _run(monkeypatch, (REFUSE_BELOW + CONFIDENT_ABOVE) / 2, llm=Model())

    assert result.answer_source == "llm"  # type: ignore[attr-defined]
    assert result.text.startswith(WEAK_MATCH_PREFIX)  # type: ignore[attr-defined]


#: The first 120 characters of the answer the free route returned on 2026-09-30.
LOOP = (
    "Hereellsellsellsellsellsellsellsellsellsellsellsellsellsellsellsellsellsellsellsells"
    " deep massellsellsellsellsell: 120 to 102 is a drawdown of -15%."
)


def test_a_looping_model_answer_falls_back_to_the_passages(monkeypatch: pytest.MonkeyPatch) -> None:
    """A loop can quote a sourced figure and pass the evidence check; it is still not text."""

    class Model:
        verdicts: typing.ClassVar[list[tuple[object, ...]]] = []

        async def complete(self, **kwargs: object) -> object:
            assert kwargs["caller"] == Caller(purpose="ask", user_id=None)

            class Completion:
                text = LOOP
                call_id = 9

            return Completion()

        async def record_verdict(self, *args: object) -> None:
            self.verdicts.append(args)

    result = _run(monkeypatch, CONFIDENT_ABOVE + 0.1, llm=Model())
    # Named and judged: the loop is on record as why the passages were used.
    assert Model.verdicts == [(9, "degenerate_completion")]

    assert result.answer_source == "extractive"  # type: ignore[attr-defined]
    assert result.fallback_reason == "degenerate_completion"  # type: ignore[attr-defined]
    assert "sellsell" not in result.text  # type: ignore[attr-defined]
    assert CHUNK.text in result.text  # type: ignore[attr-defined]
