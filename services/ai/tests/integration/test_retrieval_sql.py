"""Retrieval and topic resolution, through the real SQL.

Every line of these queries had been executed only by hand. Slice 2 of M3 shipped
two bugs that a full green suite passed and the first real query found: an
optional parameter Postgres could not type (`:model IS NULL OR ...`), and
`plainto_tsquery` ANDing a natural question into a query no chunk satisfies.
Both are pinned here.

The data is loaded the way a deployment loads it - the ingest scripts, run as
subprocesses on the fixture embedder - so these tests also cover the loaders'
own SQL. The fixture embedder ranks by shared words, which is enough to prove
the statements run and rank; it proves nothing about semantic quality, and no
assertion here pretends otherwise.
"""

from __future__ import annotations

import pytest
from sqlalchemy.engine import Engine

from app.corpus.hashed_embedder import HashedEmbedder
from app.corpus.retrieval import hybrid_search, text_search
from app.corpus.vector_store import PgVectorStore
from app.topics.resolution import resolve_topic
from app.universe.profiles import search_profiles
from tests.integration.conftest import REPO_ROOT, run_script

FIXTURE_EMBEDDER = {"EMBEDDINGS_PROVIDER": "fixture"}


@pytest.fixture(scope="module")
def loaded(migrated: Engine, database_url: str) -> Engine:
    corpus = run_script(
        database_url,
        "scripts/ingest_corpus.py",
        CORPUS_DIR=str(REPO_ROOT / "data" / "corpus"),
        **FIXTURE_EMBEDDER,
    )
    assert corpus.returncode == 0, corpus.stdout + corpus.stderr
    universe = run_script(
        database_url, "scripts/ingest_universe.py", "--fixture", **FIXTURE_EMBEDDER
    )
    assert universe.returncode == 0, universe.stdout + universe.stderr
    return migrated


async def test_hybrid_search_runs_both_halves(loaded: Engine) -> None:
    with loaded.connect() as connection:
        result = await hybrid_search(
            connection, PgVectorStore(), HashedEmbedder(), query="drawdown from a peak", limit=3
        )
    assert result.chunks, "hybrid search returned nothing over an ingested corpus"
    # Word overlap, not meaning: either document about falls from a high is a
    # fair first answer on the fixture embedder.
    assert result.chunks[0].concept_slug in {"drawdown", "peak-to-trough"}
    # Both statements ran and each placed something: a half that silently
    # returned nothing would leave its rank null on every chunk.
    assert any(chunk.vector_rank is not None for chunk in result.chunks)
    assert any(chunk.text_rank is not None for chunk in result.chunks)
    assert result.vector_is_semantic is False


def test_the_lexical_half_ors_a_question_unless_told_to_require_every_term(
    loaded: Engine,
) -> None:
    # The question from the M3 bug: ANDed, it asks one chunk to hold all five
    # stems, and none does.
    question = "how do I bring my portfolio back to its target weights"
    with loaded.connect() as connection:
        ored = text_search(connection, query=question, limit=5)
        anded = text_search(connection, query=question, limit=5, require_all_terms=True)
    assert ored, "the ORed full-text half found nothing for a question the corpus answers"
    assert len(anded) < len(ored)


async def test_the_vector_store_filters_by_model(loaded: Engine) -> None:
    # `model` is the parameter Postgres once could not type: with None, the
    # statement failed outright rather than returning a wrong answer.
    embedder = HashedEmbedder()
    vector = await embedder.embed_query("rebalancing")
    store = PgVectorStore()
    with loaded.connect() as connection:
        assert store.search(connection, embedding=vector, limit=3, model=None)
        assert store.search(connection, embedding=vector, limit=3, model=embedder.model)
        assert store.search(connection, embedding=vector, limit=3, model="no/such-model") == []


async def test_topic_resolution_searches_the_loaded_universe(loaded: Engine) -> None:
    embedder = HashedEmbedder()
    with loaded.connect() as connection:
        matches = search_profiles(
            connection,
            embedding=await embedder.embed_query("uranium mining"),
            model=embedder.model,
            limit=5,
        )
        resolution = await resolve_topic(connection, embedder, "uranium mining")
    assert matches, "no profile matched over the fixture universe"
    assert {match.symbol for match in matches} & {"CCJ", "NXE", "UEC", "LEU"}
    # The resolver abstains on the fixture embedder by design; what is proved
    # is that the whole path ran over real rows and returned a typed answer.
    assert resolution.embedding_model == embedder.model
    assert resolution.vector_is_semantic is False
