"""What `POST /ask` puts on the wire, especially when it declines.

The load-bearing assertion here is that **a refusal is a 200**. It is the output
most likely to be "fixed" into a 4xx by someone tidying up, and doing that would
make a correct refusal indistinguishable from a broken corpus to every caller,
every log and every dashboard - while M3's exit criterion names refusing
out-of-index questions as a thing the product must do well.

The service is substituted: the suite is hermetic and has no Postgres. This file
pins the wire contract, the auth and the status codes, and claims nothing about
retrieval. That part was exercised by hand against the real corpus, which is
recorded in the PR.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

import pytest
from fastapi.testclient import TestClient

from app.ask.intent import Intent
from app.ask.relevance import Relevance
from app.ask.service import Answer, Citation
from app.config import Settings, get_settings
from app.db import get_engine
from app.deps import get_embedder, get_vector_store
from app.main import app

INTERNAL_KEY = "test-key"

CITATION = Citation(
    chunk_id="chunk-1",
    document_id="doc-1",
    concept_slug="drawdown",
    title="Drawdown",
    heading="What it is",
    text="A fall from a peak to a trough.",
    similarity=0.71,
)


class _FakeEngine:
    @contextmanager
    def connect(self) -> Iterator[None]:
        yield None


def _install(monkeypatch: pytest.MonkeyPatch, answer: Answer) -> None:
    async def fake(*_args: object, **_kwargs: object) -> Answer:
        return answer

    monkeypatch.setattr("app.routers.ask.answer_question", fake)


@pytest.fixture
def client() -> Iterator[TestClient]:
    settings = Settings(_env_file=None, internal_api_key=INTERNAL_KEY)  # type: ignore[arg-type]
    app.dependency_overrides.clear()
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_engine] = _FakeEngine
    app.dependency_overrides[get_vector_store] = lambda: object()
    app.dependency_overrides[get_embedder] = lambda: object()
    yield TestClient(app)
    app.dependency_overrides.clear()


def _post(client: TestClient, **payload: object) -> object:
    return client.post(
        "/ask",
        json={"question": "what is a drawdown", **payload},
        headers={"x-internal-key": INTERNAL_KEY},
    )


def test_a_refusal_is_a_200_not_an_error(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The assertion this file exists for.

    A 4xx would make "the corpus does not cover that" - a correct, deliberate
    answer - look identical to a corpus that failed to load.
    """
    _install(
        monkeypatch,
        Answer(
            question="how do I roast a chicken",
            intent=Intent.CONCEPT,
            answered=False,
            text="I do not have anything in the reference corpus about that.",
            answer_source="none",
            relevance=Relevance.NONE,
            best_similarity=0.05,
            refused_reason="not_in_corpus",
            vector_is_semantic=True,
        ),
    )

    response = _post(client, question="how do I roast a chicken")

    assert response.status_code == 200
    body = response.json()
    assert body["answered"] is False
    assert body["refused_reason"] == "not_in_corpus"
    assert body["answer_source"] == "none"


def test_the_refusal_carries_the_number_it_was_decided_on(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """ "0.05, refused" can be argued with; "refused" cannot."""
    _install(
        monkeypatch,
        Answer(
            question="q",
            intent=Intent.CONCEPT,
            answered=False,
            text="no",
            answer_source="none",
            relevance=Relevance.NONE,
            best_similarity=0.05,
            refused_reason="not_in_corpus",
            vector_is_semantic=True,
        ),
    )

    body = _post(client).json()

    assert body["best_similarity"] == pytest.approx(0.05)
    assert body["relevance"] == "none"


def test_an_answer_carries_its_citations_verbatim(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A citation the reader cannot read is a footnote, not evidence."""
    _install(
        monkeypatch,
        Answer(
            question="what is a drawdown",
            intent=Intent.CONCEPT,
            answered=True,
            text="From Drawdown - What it is: ...",
            citations=(CITATION,),
            concept_refs=("drawdown",),
            answer_source="extractive",
            relevance=Relevance.CONFIDENT,
            best_similarity=0.71,
            vector_is_semantic=True,
        ),
    )

    body = _post(client).json()

    assert body["answered"] is True
    assert body["citations"][0]["text"] == "A fall from a peak to a trough."
    assert body["citations"][0]["chunk_id"] == "chunk-1"
    assert body["concept_refs"] == ["drawdown"]


def test_a_weak_match_is_answered_and_says_it_is_weak(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The middle band exists because the measurement supported three states."""
    _install(
        monkeypatch,
        Answer(
            question="q",
            intent=Intent.CONCEPT,
            answered=True,
            text="...",
            answer_source="extractive",
            relevance=Relevance.WEAK,
            best_similarity=0.30,
            vector_is_semantic=True,
        ),
    )

    body = _post(client).json()

    assert body["answered"] is True
    assert body["relevance"] == "weak"


def test_a_portfolio_answer_is_never_sourced_to_a_model(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _install(
        monkeypatch,
        Answer(
            question="what is my portfolio worth",
            intent=Intent.PORTFOLIO,
            answered=True,
            text="Your 3 priced holdings are worth 20500.00 USD in total.",
            evidence={"total_value_minor": 2_050_000},
            answer_source="computed",
            relevance=Relevance.CONFIDENT,
            vector_is_semantic=True,
        ),
    )

    body = _post(client, question="what is my portfolio worth").json()

    assert body["intent"] == "portfolio"
    assert body["answer_source"] == "computed"
    assert body["evidence"]["total_value_minor"] == 2_050_000


def test_an_empty_question_is_rejected(client: TestClient) -> None:
    response = client.post("/ask", json={"question": ""}, headers={"x-internal-key": INTERNAL_KEY})

    assert response.status_code == 422


def test_ask_requires_the_internal_key(client: TestClient) -> None:
    assert client.post("/ask", json={"question": "what is a drawdown"}).status_code == 401
