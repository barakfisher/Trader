"""What the fixture embedder promises, and what the column promises back.

The properties here are the ones anything downstream is entitled to rely on:
vectors are the width the schema declares, they are unit length because the index
operator assumes it, they are identical across processes because a stored vector
is compared against a query vector computed later, and they are never the zero
vector because pgvector's cosine distance against one is undefined.

The last of those is the reason this file exists at all rather than being three
assertions inside the retrieval test. A zero vector does not raise: it produces
NaN distances, which sort unpredictably, so a corpus containing one would return
a plausible-looking ranking that is partly arbitrary. That is the shape of bug
this repository keeps rediscovering - wrong in a way that looks like working
code - and it is cheap to make impossible.

What is deliberately *not* asserted here is retrieval quality. The fixture ranks
by shared words and nothing else; a test claiming it understands a question would
be a test of a thing that is not true.
"""

from __future__ import annotations

import asyncio
import math
import re
from pathlib import Path

import pytest

from app.config import Settings
from app.corpus.embedder_factory import EmbedderConfigurationError, build_embedder
from app.corpus.embeddings import EMBEDDING_DIMENSION
from app.corpus.hashed_embedder import HashedEmbedder
from app.corpus.vector_store import to_pgvector

MIGRATION = Path(__file__).resolve().parents[1] / "alembic/versions/0013_kb_embeddings.py"


def _embed(text: str, *, dimension: int = EMBEDDING_DIMENSION) -> list[float]:
    return asyncio.run(HashedEmbedder(dimension=dimension).embed_query(text))


def _cosine(left: list[float], right: list[float]) -> float:
    return sum(a * b for a, b in zip(left, right, strict=True))


def test_the_column_width_and_the_embedder_agree() -> None:
    """The one number in this slice that a migration cannot take back.

    Read out of the migration's source rather than imported, so that changing
    the column without changing the constant fails here - on a machine with no
    database - rather than at INSERT time partway through ingesting a corpus.
    """
    source = MIGRATION.read_text(encoding="utf-8")
    match = re.search(r"^EMBEDDING_DIMENSION = (\d+)$", source, re.MULTILINE)
    assert match is not None, "0013 must declare EMBEDDING_DIMENSION"

    assert int(match.group(1)) == EMBEDDING_DIMENSION
    # The column is built from that same constant rather than from a second
    # literal, so there is only one number to keep in step.
    assert "vector({EMBEDDING_DIMENSION})" in source


def test_the_index_and_the_query_agree_about_the_operator() -> None:
    """An index built for L2 and a query asking for cosine do not fail.

    Postgres simply stops using the index and answers by sequential scan, with
    an ordering that is correct but by a different measure than the one the
    embedder was normalised for. It is the same class of silent mismatch as the
    `'english'` pinning in the full-text half, and it gets the same treatment.
    """
    assert "vector_cosine_ops" in MIGRATION.read_text(encoding="utf-8")

    retrieval = (Path(__file__).resolve().parents[1] / "app/corpus/vector_store.py").read_text(
        encoding="utf-8"
    )
    assert "<=>" in retrieval, "the search must use the cosine distance operator"


def test_vectors_are_the_declared_width() -> None:
    assert len(_embed("a drawdown is a fall from a peak")) == EMBEDDING_DIMENSION


def test_vectors_are_unit_length() -> None:
    """Cosine and dot product agree only for normalised vectors."""
    norm = math.sqrt(sum(c * c for c in _embed("rebalancing returns a portfolio to target")))

    assert norm == pytest.approx(1.0)


def test_the_same_text_embeds_identically() -> None:
    """A stored vector is compared against a query vector computed much later."""
    assert _embed("volatility") == _embed("volatility")


def test_embedding_does_not_depend_on_the_process_hash_seed() -> None:
    """Python's `hash()` is salted per process; this must not use it.

    Asserted as a stable, hand-recorded value rather than by comparing two
    calls in one process, because two calls in one process share the salt and
    would agree even if the implementation were wrong. If the tokeniser or the
    hash function is deliberately changed, `HashedEmbedder.model` must change
    with it - that string is what decides whether stored rows are re-embedded -
    and this number is then re-recorded on purpose.
    """
    # One token at a width small enough to write down, so the whole vector is
    # a single bucket. Recorded from the implementation; it is stable across
    # runs, processes and machines, which is the property being tested.
    assert _embed("drawdown", dimension=8) == [0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]


def test_text_with_no_tokens_is_never_the_zero_vector() -> None:
    """pgvector's cosine distance to a zero vector is NaN, and NaN sorts badly."""
    for empty in ("", "   ", "!!!", "—"):
        vector = _embed(empty)
        assert math.sqrt(sum(c * c for c in vector)) == pytest.approx(1.0)


def test_shared_words_score_higher_than_unrelated_ones() -> None:
    """The only quality claim this embedder supports, stated as its limit.

    Lexical overlap and nothing else: this is what makes the retrieval path
    testable at all, and it is also exactly why a real model is owed. The second
    assertion is the honest half - a question that means the same thing in
    different words scores near zero, which is the failure the paid provider
    fixes and no amount of tuning here will.
    """
    chunk = _embed("a drawdown is the fall from a peak to a trough")
    shares_words = _cosine(chunk, _embed("drawdown peak trough"))
    means_the_same = _cosine(chunk, _embed("how much did I lose from the top"))

    # A ratio rather than two thresholds, per CLAUDE.md: the absolute numbers
    # are a consequence of the corpus's vocabulary and would make this test fail
    # for reasons that have nothing to do with the behaviour it describes.
    assert shares_words > 2 * means_the_same

    # And the limit, asserted rather than only written down. The paraphrase
    # scores above zero only because both strings contain "from" and "the" -
    # the embedder has no stopword notion, unlike the `english` configuration
    # the full-text half uses. That is noise, and it is what a real embedding
    # model replaces with meaning.
    assert means_the_same < 0.25


def test_a_query_matches_itself_exactly() -> None:
    """Document and query tokenisation must not drift apart.

    If they did, a chunk would score below 1.0 against its own text - a bug that
    looks like a tuning problem and is not one.
    """
    text = "rebalancing returns a portfolio to its target weights"

    assert _cosine(_embed(text), _embed(text)) == pytest.approx(1.0)


def test_a_mis_sized_vector_is_refused_before_it_reaches_postgres() -> None:
    """Named so the message blames the embedder, which is what is wrong."""
    with pytest.raises(ValueError, match="dimensions"):
        to_pgvector([0.0, 1.0])


def test_the_fixture_embedder_is_free_and_says_so() -> None:
    """Mirrors `LLMProvider.charges_per_token`; an operator is told which they run."""
    embedder = build_embedder(Settings(_env_file=None))  # type: ignore[arg-type]

    assert embedder.charges_per_token is False
    assert embedder.dimension == EMBEDDING_DIMENSION


def test_an_unknown_provider_refuses_rather_than_degrading() -> None:
    """There is no honest null embedding - see app/corpus/embedder_factory.py.

    Retrieval that quietly runs on one of its two halves while still reporting
    scores and an ordering is the silent-degradation failure this project exists
    to avoid, so the misconfiguration stops the caller instead.
    """
    settings = Settings(_env_file=None, embeddings_provider="wat")  # type: ignore[arg-type]

    with pytest.raises(EmbedderConfigurationError, match="not a known embedder"):
        build_embedder(settings)


def test_a_planned_provider_says_it_is_planned_not_that_it_is_a_typo() -> None:
    """`openrouter` is the owed migration; an operator who tries it deserves to know."""
    settings = Settings(_env_file=None, embeddings_provider="openrouter")  # type: ignore[arg-type]

    with pytest.raises(EmbedderConfigurationError, match="not implemented yet"):
        build_embedder(settings)


def test_the_m0_placeholder_value_is_told_what_to_do_instead() -> None:
    """Every .env written from the M0 example carries `fastembed`.

    That block named a provider nobody implemented and a 384-wide model, so an
    upgrade would otherwise greet those installations with "not a known
    embedder" - which reads like a typo they did not make.
    """
    settings = Settings(_env_file=None, embeddings_provider="fastembed")  # type: ignore[arg-type]

    with pytest.raises(EmbedderConfigurationError, match="EMBEDDINGS_PROVIDER=fixture"):
        build_embedder(settings)
