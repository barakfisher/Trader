"""What a concept chip gets back, and what a missing one gets back.

The interesting case is the second. A slug the corpus does not hold must answer
404 with the concept named, because that is an ordinary state rather than a
fault: an environment that has not run the ingester has an empty corpus, and the
first thing it shows a user must not be an error page. The orchestrator turns
this into "no explanation is available", which only works if the status is
distinguishable from a real failure.

The repository is substituted rather than exercised: the suite is hermetic and
has no Postgres. What that leaves unproven - the SQL - is covered by running the
route against the real database, where `/concepts` listed the nine slugs and
`/concepts/rebalancing` returned its four sections in order. This file pins the
routing, the auth contract and the 404 mapping, and claims nothing else.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

import pytest
from fastapi.testclient import TestClient

from app.config import Settings, get_settings
from app.db import get_engine
from app.main import app
from app.models import ConceptDocumentResponse, ConceptSection

INTERNAL_KEY = "test-key"

DOCUMENT = ConceptDocumentResponse(
    slug="drawdown",
    title="Drawdown",
    source="traders-curated",
    uri=None,
    license="CC0-1.0",
    sections=[
        ConceptSection(id="chunk-1", ord=1, heading="What it is", text="A fall from a high."),
        ConceptSection(id="chunk-2", ord=2, heading="How it is computed", text="Latest v. high."),
    ],
)


class _FakeEngine:
    """Stands in for the engine so the route can run with no database."""

    @contextmanager
    def connect(self) -> Iterator[None]:
        yield None


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    settings = Settings(_env_file=None, internal_api_key=INTERNAL_KEY)  # type: ignore[arg-type]
    app.dependency_overrides.clear()
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_engine] = _FakeEngine

    monkeypatch.setattr(
        "app.routers.concepts.concept_by_slug",
        lambda _connection, slug: DOCUMENT if slug == "drawdown" else None,
    )
    monkeypatch.setattr(
        "app.routers.concepts.concept_slugs",
        lambda _connection: ["drawdown", "volatility"],
    )
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_returns_the_document_with_its_sections_in_order(client: TestClient) -> None:
    response = client.get("/concepts/drawdown", headers={"x-internal-key": INTERNAL_KEY})

    assert response.status_code == 200
    body = response.json()
    assert body["title"] == "Drawdown"
    assert [section["ord"] for section in body["sections"]] == [1, 2]


def test_carries_the_licence_and_source(client: TestClient) -> None:
    """A reader is entitled to know who wrote the explanation they are shown."""
    body = client.get("/concepts/drawdown", headers={"x-internal-key": INTERNAL_KEY}).json()

    assert body["license"] == "CC0-1.0"
    assert body["source"] == "traders-curated"


def test_a_missing_concept_is_a_named_404_not_a_failure(client: TestClient) -> None:
    response = client.get("/concepts/not-a-concept", headers={"x-internal-key": INTERNAL_KEY})

    assert response.status_code == 404
    # The slug and the likely cause both appear, because the most common reason
    # for this in a fresh environment is an un-ingested corpus rather than a
    # concept nobody wrote.
    assert "not-a-concept" in response.json()["detail"]
    assert "ingested" in response.json()["detail"]


def test_lists_every_available_concept(client: TestClient) -> None:
    response = client.get("/concepts", headers={"x-internal-key": INTERNAL_KEY})

    assert response.status_code == 200
    assert response.json() == ["drawdown", "volatility"]


@pytest.mark.parametrize("path", ["/concepts", "/concepts/drawdown"])
def test_requires_the_internal_key(client: TestClient, path: str) -> None:
    """The corpus is part of the product, not a public API."""
    assert client.get(path).status_code == 401
