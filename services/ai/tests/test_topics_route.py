"""What `POST /topics/resolve` puts on the wire, especially with no universe.

The load-bearing assertion is that **an installation with no searchable
universe answers `unavailable`, never `none`, and never reaches the resolver.**
Both alternatives are easy to fall into. The resolver itself, run over an empty
table, grades the missing evidence `weak` with no candidates (that is
`judge(None)`'s rule for `/ask`); a tidier version would say `none`. Either tells
the user something about their topic when the truth is about the installation.

The resolver and the coverage count are substituted: the suite is hermetic and
has no Postgres. This file pins the wire contract, the auth and the branching;
the SQL underneath is exercised by the compose smoke test and by hand.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

import pytest
from fastapi.testclient import TestClient

from app.ask.relevance import Relevance, RelevanceJudgement
from app.config import Settings, get_settings
from app.db import get_engine
from app.deps import get_embedder
from app.main import app
from app.topics.resolution import (
    NOTHING_BELOW,
    STRONG_ABOVE,
    Interpretation,
    TopicCandidate,
    TopicResolution,
)
from app.universe.profiles import Holder, UniverseCoverage, UniverseState

INTERNAL_KEY = "test-key"
SEMANTIC_MODEL = "openai/text-embedding-3-small"

CANDIDATE = TopicCandidate(
    instrument_id="00000000-0000-0000-0000-000000000001",
    symbol="CCJ",
    name="Cameco Corporation",
    asset_class="equity",
    sector="Energy",
    industry="Uranium",
    similarity=0.52,
    size_minor=3_500_000_000_000,
    size_currency="USD",
    confidence=Relevance.CONFIDENT,
    rationale="The company provides uranium for the generation of electricity.",
    held_by=(Holder(etf="URA", weight="0.2231"),),
)


class _FakeEngine:
    @contextmanager
    def connect(self) -> Iterator[None]:
        yield None


class _Embedder:
    model = SEMANTIC_MODEL


class _Calls:
    def __init__(self) -> None:
        self.resolved: list[str] = []


@pytest.fixture
def client() -> Iterator[TestClient]:
    settings = Settings(_env_file=None, internal_api_key=INTERNAL_KEY)  # type: ignore[arg-type]
    app.dependency_overrides.clear()
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_engine] = _FakeEngine
    app.dependency_overrides[get_embedder] = _Embedder
    yield TestClient(app)
    app.dependency_overrides.clear()


def _install(
    monkeypatch: pytest.MonkeyPatch,
    covered: UniverseCoverage,
    resolution: TopicResolution | None = None,
) -> _Calls:
    calls = _Calls()

    def fake_coverage(_connection: object, *, model: str) -> UniverseCoverage:
        assert model == SEMANTIC_MODEL, "coverage must be counted for the model being searched"
        return covered

    async def fake_resolve(_connection: object, _embedder: object, topic: str) -> TopicResolution:
        calls.resolved.append(topic)
        assert resolution is not None, "the resolver was reached with no searchable universe"
        return resolution

    monkeypatch.setattr("app.routers.topics.coverage", fake_coverage)
    monkeypatch.setattr("app.routers.topics.resolve_topic", fake_resolve)
    return calls


def _resolution(
    relevance: Relevance, interpretations: list[Interpretation], best: float = 0.52
) -> TopicResolution:
    return TopicResolution(
        topic="uranium",
        judgement=RelevanceJudgement(relevance, best, NOTHING_BELOW, STRONG_ABOVE),
        interpretations=interpretations,
        embedding_model=SEMANTIC_MODEL,
        vector_is_semantic=True,
    )


def _post(client: TestClient, topic: str = "uranium", **headers: str) -> object:
    return client.post(
        "/topics/resolve",
        json={"topic": topic},
        headers={"x-internal-key": INTERNAL_KEY, **headers},
    )


@pytest.mark.parametrize(
    ("covered", "state"),
    [
        (UniverseCoverage(profiles=0, embedded=0), "not_loaded"),
        (UniverseCoverage(profiles=5223, embedded=0), "not_embedded"),
    ],
)
def test_no_searchable_universe_is_unavailable_and_never_resolved(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    covered: UniverseCoverage,
    state: str,
) -> None:
    calls = _install(monkeypatch, covered)

    response = _post(client)

    assert response.status_code == 200
    body = response.json()
    assert body["verdict"] == "unavailable"
    assert body["verdict"] != "none", "no universe must never read as 'nothing matches'"
    assert body["universe"] == {
        "state": state,
        "profiles": covered.profiles,
        "embedded": covered.embedded,
    }
    assert body["interpretations"] == []
    assert body["best_similarity"] is None
    assert calls.resolved == []


def test_a_resolved_topic_carries_every_reason_to_the_wire(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    covered = UniverseCoverage(profiles=5223, embedded=5223)
    _install(
        monkeypatch,
        covered,
        _resolution(Relevance.CONFIDENT, [Interpretation(label="Uranium", candidates=[CANDIDATE])]),
    )

    body = _post(client).json()

    assert body["verdict"] == "confident"
    assert body["universe"]["state"] == "ready"
    assert body["refuse_below"] == NOTHING_BELOW
    assert body["confident_above"] == STRONG_ABOVE
    assert body["ambiguous"] is False
    [interpretation] = body["interpretations"]
    assert interpretation["label"] == "Uranium"
    [candidate] = interpretation["candidates"]
    assert candidate["instrument_id"] == CANDIDATE.instrument_id
    assert candidate["confidence"] == "confident"
    assert candidate["rationale"] == CANDIDATE.rationale
    # Money is minor units with its currency; a weight is a decimal string.
    assert candidate["size_minor"] == CANDIDATE.size_minor
    assert candidate["size_currency"] == "USD"
    assert candidate["held_by"] == [{"etf": "URA", "weight": "0.2231"}]


def test_a_topic_nothing_is_about_is_none_with_no_candidates(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _install(
        monkeypatch,
        UniverseCoverage(profiles=5223, embedded=5223),
        _resolution(Relevance.NONE, [], best=0.21),
    )

    body = _post(client, "best hiking trails in patagonia").json()

    assert body["verdict"] == "none"
    assert body["interpretations"] == []
    assert body["best_similarity"] == 0.21


def test_a_partially_embedded_universe_is_searched_and_says_so(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = _install(
        monkeypatch,
        UniverseCoverage(profiles=5223, embedded=100),
        _resolution(Relevance.WEAK, [Interpretation(label=None, candidates=[CANDIDATE])]),
    )

    body = _post(client).json()

    assert calls.resolved == ["uranium"]
    assert body["verdict"] == "weak"
    assert body["universe"] == {"state": "partially_embedded", "profiles": 5223, "embedded": 100}


def test_two_interpretations_are_ambiguous(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    meaning = Interpretation(label="Gold", candidates=[CANDIDATE])
    _install(
        monkeypatch,
        UniverseCoverage(profiles=10, embedded=10),
        _resolution(Relevance.CONFIDENT, [meaning, meaning]),
    )

    assert _post(client, "mining").json()["ambiguous"] is True


def test_the_topic_is_trimmed_before_it_is_resolved(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = _install(
        monkeypatch,
        UniverseCoverage(profiles=10, embedded=10),
        _resolution(Relevance.WEAK, []),
    )

    _post(client, "  uranium \n")

    assert calls.resolved == ["uranium"]


@pytest.mark.parametrize("topic", ["", "   ", "x" * 201])
def test_an_empty_or_oversized_topic_is_rejected(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, topic: str
) -> None:
    calls = _install(monkeypatch, UniverseCoverage(profiles=10, embedded=10))

    assert _post(client, topic).status_code == 422
    assert calls.resolved == []


def test_the_internal_key_is_required(client: TestClient) -> None:
    response = client.post("/topics/resolve", json={"topic": "uranium"})
    assert response.status_code == 401


@pytest.mark.parametrize(
    ("profiles", "embedded", "state"),
    [
        (0, 0, UniverseState.NOT_LOADED),
        (5, 0, UniverseState.NOT_EMBEDDED),
        (5, 3, UniverseState.PARTIALLY_EMBEDDED),
        (5, 5, UniverseState.READY),
    ],
)
def test_coverage_names_the_missing_step(
    profiles: int, embedded: int, state: UniverseState
) -> None:
    covered = UniverseCoverage(profiles=profiles, embedded=embedded)
    assert covered.state is state
    assert covered.searchable is (embedded > 0)
