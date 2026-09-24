"""How two rankings become one, and what the fused answer admits about itself.

`reciprocal_rank_fusion` is pure and is tested directly, which is the reason it
was separated from the SQL at all. The properties pinned here are the ones a
reader of a search result is entitled to assume: agreement between the two halves
beats a single confident ranker, a chunk only one half found still appears, the
order is deterministic under ties, and `k` is referred to by name so retuning it
cannot break a test about something else.

`hybrid_search` is exercised against a fake store and a fake full-text half,
because the suite is hermetic and has no Postgres. That is enough to pin the
orchestration - which half is asked for what, that an un-embedded corpus still
answers, that the honesty flag is carried - and it is not enough to prove the two
SQL statements are correct. That gap is real and is the reason `/concepts/search`
exists in this slice: it is the surface the SQL gets exercised through, by hand
and in the compose job, before slice 3 builds on it.
"""

from __future__ import annotations

import asyncio

from app.corpus.embeddings import EMBEDDING_DIMENSION
from app.corpus.hashed_embedder import HashedEmbedder
from app.corpus.retrieval import (
    RRF_K,
    ScoredChunk,
    hybrid_search,
    reciprocal_rank_fusion,
)
from app.corpus.vector_store import EmbeddingCoverage, VectorMatch


def test_a_chunk_both_halves_rank_second_beats_one_only_one_half_found() -> None:
    """The whole reason to fuse rather than to pick a winner.

    Agreement between two different notions of relevance is stronger evidence
    than one ranker's confidence - which matters most while one of the two halves
    is a placeholder that ranks by shared words.
    """
    fused = reciprocal_rank_fusion([["a", "b"], ["c", "b"]])

    assert fused["b"][0] > fused["a"][0]
    assert fused["b"][0] > fused["c"][0]


def test_a_chunk_only_one_half_found_is_still_returned() -> None:
    """Dropping it would make the hybrid an intersection, not a union.

    A question phrased in words the corpus does not use has nothing for the
    full-text half to match, and that is exactly when the vector half is the only
    one that can answer.
    """
    fused = reciprocal_rank_fusion([["a"], ["b"]])

    assert set(fused) == {"a", "b"}


def test_the_rank_of_the_half_that_did_not_find_a_chunk_is_none() -> None:
    """None means "not returned", which is different from "returned last".

    It is carried to the API response because a null vector rank on every match
    is how a reader can tell the corpus is not embedded - a state that otherwise
    looks exactly like working hybrid retrieval.
    """
    _score, ranks = reciprocal_rank_fusion([["a"], ["b"]])["a"]

    assert ranks == [1, None]


def test_the_score_is_the_reciprocal_rank_sum_over_k() -> None:
    """Asserted through the constant, never through its current value."""
    fused = reciprocal_rank_fusion([["a"], ["a"]])

    assert fused["a"][0] == 2 / (RRF_K + 1)


def test_k_is_honoured_when_passed() -> None:
    """A smaller k sharpens the difference between rank 1 and rank 2."""
    flat = reciprocal_rank_fusion([["a", "b"]], k=RRF_K)
    sharp = reciprocal_rank_fusion([["a", "b"]], k=1)

    assert sharp["a"][0] / sharp["b"][0] > flat["a"][0] / flat["b"][0]


def test_a_duplicate_within_one_ranking_is_counted_once() -> None:
    """Otherwise one half could outvote the other on its own."""
    fused = reciprocal_rank_fusion([["a", "a"], ["b"]])

    assert fused["a"][0] == 1 / (RRF_K + 1)
    assert fused["a"][1] == [1, None]


def test_an_empty_ranking_contributes_nothing_and_does_not_raise() -> None:
    """The full-text half returns no rows for a query with no matching terms."""
    fused = reciprocal_rank_fusion([[], ["a"]])

    assert fused["a"][1] == [None, 1]


# --------------------------------------------------------------------------
# hybrid_search, against fakes
# --------------------------------------------------------------------------


def _match(chunk_id: str, *, slug: str = "drawdown") -> VectorMatch:
    return VectorMatch(
        chunk_id=chunk_id,
        document_id=f"doc-{slug}",
        concept_slug=slug,
        title=slug.title(),
        heading="What it is",
        ord=1,
        text=f"text for {chunk_id}",
        similarity=0.9,
    )


class FakeStore:
    """Records what it was asked for and answers with `matches`."""

    def __init__(self, matches: list[VectorMatch] | None = None) -> None:
        self.matches = matches or []
        self.search_kwargs: dict[str, object] = {}

    def pending_chunks(self, _connection: object, **_kwargs: object) -> list[object]:
        return []

    def store_embeddings(self, _connection: object, **_kwargs: object) -> int:
        return 0

    def search(self, _connection: object, **kwargs: object) -> list[VectorMatch]:
        self.search_kwargs = kwargs
        return self.matches

    def coverage(self, _connection: object, **_kwargs: object) -> EmbeddingCoverage:
        return EmbeddingCoverage(total=0, embedded=0, models=())


def _run(
    monkeypatch: object,
    *,
    vector: list[VectorMatch],
    fulltext: list[str],
    query: str = "what is a drawdown",
    limit: int = 5,
    embedder: object | None = None,
    seen: dict[str, object] | None = None,
) -> tuple[tuple[ScoredChunk, ...], FakeStore]:
    from app.corpus import retrieval

    store = FakeStore(vector)

    def fake_text_search(_c: object, **kwargs: object) -> list[object]:
        if seen is not None:
            seen.update(kwargs)
        return [retrieval._candidate_from_vector_match(_match(i)) for i in fulltext]

    monkeypatch.setattr(retrieval, "text_search", fake_text_search)  # type: ignore[attr-defined]
    result = asyncio.run(
        hybrid_search(  # type: ignore[arg-type]
            None, store, embedder or HashedEmbedder(), query=query, limit=limit
        )
    )
    return result.chunks, store


def test_both_halves_are_asked_and_their_results_are_merged(monkeypatch: object) -> None:
    chunks, _store = _run(monkeypatch, vector=[_match("v1")], fulltext=["t1"])

    assert {chunk.chunk_id for chunk in chunks} == {"v1", "t1"}


def test_the_vector_half_is_asked_only_for_rows_this_embedder_produced(
    monkeypatch: object,
) -> None:
    """The one way these tables return confident nonsense.

    A query vector compared against rows a different model wrote has the right
    width and a working operator, and distances that mean nothing at all. So the
    filter is part of the search, not an optimisation.
    """
    _chunks, store = _run(monkeypatch, vector=[_match("v1")], fulltext=[])

    assert store.search_kwargs["model"] == HashedEmbedder.model


def test_an_unembedded_corpus_still_answers_and_says_the_vector_half_was_silent(
    monkeypatch: object,
) -> None:
    """Ingested-but-not-embedded is a legitimate state, not a broken one."""
    chunks, _store = _run(monkeypatch, vector=[], fulltext=["t1", "t2"])

    assert [chunk.chunk_id for chunk in chunks] == ["t1", "t2"]
    assert all(chunk.vector_rank is None for chunk in chunks)
    assert all(chunk.text_rank is not None for chunk in chunks)


def test_an_empty_query_returns_nothing_rather_than_something(monkeypatch: object) -> None:
    """Both halves would answer it, and neither answer would mean anything."""
    chunks, store = _run(monkeypatch, vector=[_match("v1")], fulltext=["t1"], query="   ")

    assert chunks == ()
    assert store.search_kwargs == {}, "the vector half must not even be asked"


def test_the_limit_is_applied_after_fusion_not_before(monkeypatch: object) -> None:
    """Truncating each half first would discard exactly what fusion rewards.

    A chunk both halves rank low is a strong result and only becomes one once
    the two are combined.
    """
    chunks, _store = _run(
        monkeypatch,
        vector=[_match("a"), _match("b"), _match("c")],
        fulltext=["c", "b", "a"],
        limit=2,
    )

    assert len(chunks) == 2


def test_the_order_is_deterministic_under_ties(monkeypatch: object) -> None:
    """Two halves ranking symmetrically produce equal scores; that is common.

    An order that changes between identical calls gets diagnosed as a caching
    bug, which costs an afternoon and finds nothing.
    """
    first, _ = _run(monkeypatch, vector=[_match("b"), _match("a")], fulltext=["a", "b"])
    second, _ = _run(monkeypatch, vector=[_match("b"), _match("a")], fulltext=["a", "b"])

    assert [chunk.chunk_id for chunk in first] == [chunk.chunk_id for chunk in second]


def test_the_answer_states_that_the_fixture_embedder_is_not_semantic(
    monkeypatch: object,
) -> None:
    """Carried to the wire, not logged: a caller cannot otherwise tell.

    A search that ranks well on shared words looks identical to one that
    understood the question, and the difference is the whole owed migration.
    """
    from app.corpus import retrieval

    monkeypatch.setattr(retrieval, "text_search", lambda _c, **_k: [])  # type: ignore[attr-defined]
    result = asyncio.run(
        hybrid_search(
            None,  # type: ignore[arg-type]
            FakeStore(),
            HashedEmbedder(),
            query="drawdown",
            limit=5,
        )
    )

    assert result.vector_is_semantic is False
    assert result.embedding_model == HashedEmbedder.model


def test_the_query_embedding_is_the_width_the_column_declares() -> None:
    """A mis-sized query vector fails in Postgres, naming the column not the model."""
    assert len(asyncio.run(HashedEmbedder().embed_query("drawdown"))) == EMBEDDING_DIMENSION


# --------------------------------------------------------------------------
# How strict the lexical half is depends on what the other half can do
# --------------------------------------------------------------------------


class SemanticEmbedder(HashedEmbedder):
    """A stand-in for a real embedding model - same vectors, different name.

    Only the model id matters here: `_NON_SEMANTIC_MODELS` is a list rather
    than a detected property precisely so that adding a real provider cannot
    quietly flip the flag for an embedder nobody assessed.
    """

    model = "openai/text-embedding-3-small"


def test_a_placeholder_embedder_widens_the_lexical_half(monkeypatch: object) -> None:
    """AND matched nothing for three of four real questions, measured.

    When the vector half ranks by shared words, the lexical half is the only
    real one - and a real half that is silent is no half at all.
    """
    seen: dict[str, object] = {}

    _run(monkeypatch, vector=[], fulltext=["t1"], seen=seen)

    assert seen["require_all_terms"] is False


def test_a_semantic_embedder_tightens_the_lexical_half(monkeypatch: object) -> None:
    """Fusing a 2/6 ranker with a 5/6 ranker at equal weight measured 4/6.

    Once the vector half can carry a paraphrase, the widened lexical half
    competes with it instead of complementing it. Strict, it stays silent
    unless confident - which is what took the hybrid back to 5/6.
    """
    seen: dict[str, object] = {}

    _run(monkeypatch, vector=[], fulltext=["t1"], embedder=SemanticEmbedder(), seen=seen)

    assert seen["require_all_terms"] is True


def test_the_strictness_and_the_reported_flag_come_from_one_decision(
    monkeypatch: object,
) -> None:
    """They must never disagree.

    `vector_is_semantic` is what the API tells a reader, and `require_all_terms`
    is what the query actually did. If one could be true while the other was
    false, the response would describe a search that did not happen.
    """
    from app.corpus import retrieval

    seen: dict[str, object] = {}
    monkeypatch.setattr(  # type: ignore[attr-defined]
        retrieval,
        "text_search",
        lambda _c, **kwargs: (seen.update(kwargs), [])[1],
    )
    result = asyncio.run(
        hybrid_search(  # type: ignore[arg-type]
            None, FakeStore(), SemanticEmbedder(), query="drawdown", limit=3
        )
    )

    assert result.vector_is_semantic is seen["require_all_terms"]
