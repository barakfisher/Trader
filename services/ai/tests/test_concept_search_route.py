"""What `/concepts/search` answers, and the route it must not be shadowed by.

The first test here is the one worth having. `/concepts/search` and
`/concepts/{slug}` are the same shape to FastAPI, which matches in registration
order - so declaring the path parameter first makes `search` a request for a
concept called "search". That fails as a 404 naming a slug nobody asked for,
which reads as an un-ingested corpus rather than as a shadowed route, and the
person debugging it goes and looks at the database. It costs nothing to pin and
it is invisible in review.

Everything under the route is substituted: the suite is hermetic and has no
Postgres, so this file pins routing, auth and the response shape and claims
nothing about the SQL. The SQL is exercised through this same endpoint against a
real database, which is why it exists in this slice rather than in slice 3.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

import pytest
from fastapi.testclient import TestClient

from app.config import Settings, get_settings
from app.corpus.retrieval import HybridResult, ScoredChunk
from app.db import get_engine
from app.deps import get_embedder, get_vector_store
from app.main import app

INTERNAL_KEY = "test-key"

CHUNK = ScoredChunk(
    chunk_id="chunk-1",
    document_id="doc-1",
    concept_slug="drawdown",
    title="Drawdown",
    heading="What it is",
    ord=1,
    text="A fall from a peak to a trough.",
    score=0.032,
    vector_rank=1,
    text_rank=2,
)


class _FakeEngine:
    @contextmanager
    def connect(self) -> Iterator[None]:
        yield None


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    settings = Settings(_env_file=None, internal_api_key=INTERNAL_KEY)  # type: ignore[arg-type]
    app.dependency_overrides.clear()
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_engine] = _FakeEngine
    app.dependency_overrides[get_vector_store] = lambda: object()
    app.dependency_overrides[get_embedder] = lambda: object()

    async def fake_search(
        *_args: object, query: str, limit: int, **_kwargs: object
    ) -> HybridResult:
        return HybridResult(
            query=query,
            chunks=(CHUNK,)[:limit],
            embedding_model="fixture/hashed-v1",
            vector_is_semantic=False,
        )

    monkeypatch.setattr("app.routers.concepts.hybrid_search", fake_search)
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_search_is_not_shadowed_by_the_slug_route(client: TestClient) -> None:
    """Registration order is what makes this work, and it is easy to undo."""
    response = client.get(
        "/concepts/search", params={"q": "drawdown"}, headers={"x-internal-key": INTERNAL_KEY}
    )

    assert response.status_code == 200
    assert response.json()["query"] == "drawdown"


def test_a_match_carries_both_halves_ranks(client: TestClient) -> None:
    """The only way a reader can tell which half of the hybrid found a result."""
    body = client.get(
        "/concepts/search", params={"q": "drawdown"}, headers={"x-internal-key": INTERNAL_KEY}
    ).json()

    assert body["matches"][0]["vector_rank"] == 1
    assert body["matches"][0]["text_rank"] == 2


def test_the_response_says_the_vector_half_is_not_semantic(client: TestClient) -> None:
    """Guideline 7 in its retrieval form: what is unavailable is reported so.

    A ranking produced by word overlap is indistinguishable from one produced by
    understanding, from the outside. So the answer states which it was.
    """
    body = client.get(
        "/concepts/search", params={"q": "drawdown"}, headers={"x-internal-key": INTERNAL_KEY}
    ).json()

    assert body["vector_is_semantic"] is False
    assert body["embedding_model"] == "fixture/hashed-v1"


def test_a_citation_can_name_the_chunk_it_came_from(client: TestClient) -> None:
    """`/ask` cites a chunk, not a document - the ids have to survive the wire."""
    match = client.get(
        "/concepts/search", params={"q": "drawdown"}, headers={"x-internal-key": INTERNAL_KEY}
    ).json()["matches"][0]

    assert match["chunk_id"] == "chunk-1"
    assert match["document_id"] == "doc-1"
    assert match["concept_slug"] == "drawdown"


def test_the_limit_is_bounded(client: TestClient) -> None:
    """An unbounded limit makes one request able to read the whole corpus out."""
    response = client.get(
        "/concepts/search",
        params={"q": "drawdown", "limit": 500},
        headers={"x-internal-key": INTERNAL_KEY},
    )

    assert response.status_code == 422


def test_search_requires_the_internal_key(client: TestClient) -> None:
    assert client.get("/concepts/search", params={"q": "drawdown"}).status_code == 401
