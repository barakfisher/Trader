"""What the paid embedder does with an answer it cannot trust.

Every test here drives a `httpx.MockTransport`, so the suite stays hermetic and
keyless while exercising the real request-building and response-parsing code.
What that cannot prove is that OpenRouter's endpoint actually behaves this way -
that was checked by pointing it at the live API once and re-embedding the corpus,
which is recorded in the PR rather than asserted here.

The cases worth having are the malformed ones. A wrong vector *width* and an
out-of-order response are the two failures that would otherwise be stored: both
produce a corpus that looks fully embedded and ranks by nothing in particular,
and neither raises on its own. Everything downstream - `ingest.py`, the store,
retrieval - would report success.
"""

from __future__ import annotations

import asyncio

import httpx
import pytest

from app.config import Settings
from app.corpus.embedder_factory import EmbedderConfigurationError, build_embedder
from app.corpus.embeddings import EMBEDDING_DIMENSION, EmbeddingError
from app.corpus.openrouter_embedder import OpenRouterEmbedder

#: A unit vector of the declared width, which is what a healthy call returns.
UNIT = [1.0] + [0.0] * (EMBEDDING_DIMENSION - 1)


def _embedder(handler: object, **kwargs: object) -> OpenRouterEmbedder:
    return OpenRouterEmbedder(
        model="openai/text-embedding-3-small",
        base_url="https://openrouter.test/api/v1",
        api_key="test-key",
        retry_backoff_seconds=0.0,
        transport=httpx.MockTransport(handler),  # type: ignore[arg-type]
        **kwargs,  # type: ignore[arg-type]
    )


def _ok(vectors: list[list[float]], *, tokens: int = 12) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "data": [
                {"index": i, "embedding": vector, "object": "embedding"}
                for i, vector in enumerate(vectors)
            ],
            "usage": {"prompt_tokens": tokens, "total_tokens": tokens},
        },
    )


def test_a_healthy_call_returns_one_unit_vector_per_input() -> None:
    embedder = _embedder(lambda _request: _ok([UNIT, UNIT]))

    vectors = asyncio.run(embedder.embed_documents(["a", "b"]))

    assert len(vectors) == 2
    assert all(len(v) == EMBEDDING_DIMENSION for v in vectors)


def test_the_request_carries_the_model_and_every_input() -> None:
    """Pinned because the body is invisible in a successful response."""
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(__import__("json").loads(request.content))
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("authorization")
        return _ok([UNIT, UNIT])

    asyncio.run(_embedder(handler).embed_documents(["first", "second"]))

    assert seen["url"] == "https://openrouter.test/api/v1/embeddings"
    assert seen["model"] == "openai/text-embedding-3-small"
    assert seen["input"] == ["first", "second"]
    assert seen["auth"] == "Bearer test-key"


def test_the_dimensions_parameter_is_deliberately_not_sent() -> None:
    """Only the text-embedding-3-* family supports it.

    Sending it unconditionally makes every other model a hard failure, and
    sending it conditionally means a heuristic over model names - which this
    codebase already regrets once, in `cache_policy.py`. The width is verified
    on arrival instead.
    """
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(__import__("json").loads(request.content))
        return _ok([UNIT])

    asyncio.run(_embedder(handler).embed_query("drawdown"))

    assert "dimensions" not in seen


def test_a_wrong_width_is_refused_and_names_both_numbers() -> None:
    """The failure that would otherwise be stored and look like a bad model.

    `text-embedding-3-large` is natively 3072 wide, so this is the exact error
    somebody switching models meets - and the message has to tell them the fix
    rather than only the fact.
    """
    embedder = _embedder(lambda _request: _ok([[0.5] * 3072]))

    with pytest.raises(EmbeddingError) as error:
        asyncio.run(embedder.embed_query("drawdown"))

    assert "3072" in str(error.value)
    assert str(EMBEDDING_DIMENSION) in str(error.value)
    assert "dimensions" in str(error.value)


def test_items_are_reordered_by_index_rather_than_trusted() -> None:
    """The endpoint is not obliged to answer in order.

    A transposition would store every chunk after it under its neighbour's
    vector - a corpus where `drawdown` is indexed as `rebalancing`, which
    nothing downstream could distinguish from a merely bad embedding model.
    """
    first = [1.0] + [0.0] * (EMBEDDING_DIMENSION - 1)
    second = [0.0, 1.0] + [0.0] * (EMBEDDING_DIMENSION - 2)

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "data": [
                    {"index": 1, "embedding": second},
                    {"index": 0, "embedding": first},
                ],
                "usage": {"prompt_tokens": 4},
            },
        )

    vectors = asyncio.run(_embedder(handler).embed_documents(["a", "b"]))

    assert vectors[0][0] == pytest.approx(1.0)
    assert vectors[1][1] == pytest.approx(1.0)


def test_a_short_response_is_refused_rather_than_zipped() -> None:
    embedder = _embedder(lambda _request: _ok([UNIT]))

    with pytest.raises(EmbeddingError, match="1 embeddings for 2 inputs"):
        asyncio.run(embedder.embed_documents(["a", "b"]))


def test_a_zero_vector_is_refused_rather_than_stored() -> None:
    """pgvector's cosine distance to a zero vector is NaN, and NaN sorts badly.

    Refused rather than substituted: unlike the fixture embedder, which meets
    this on genuinely empty text, a paid endpoint returning no direction at all
    means something upstream is wrong.
    """
    embedder = _embedder(lambda _request: _ok([[0.0] * EMBEDDING_DIMENSION]))

    with pytest.raises(EmbeddingError, match="zero vector"):
        asyncio.run(embedder.embed_query("drawdown"))


def test_vectors_are_normalised_even_when_the_endpoint_does_not() -> None:
    """The index is cosine; the contract says unit length. Do not assume."""
    embedder = _embedder(lambda _request: _ok([[3.0, 4.0] + [0.0] * (EMBEDDING_DIMENSION - 2)]))

    vector = asyncio.run(embedder.embed_query("drawdown"))

    assert vector[0] == pytest.approx(0.6)
    assert vector[1] == pytest.approx(0.8)


def test_a_rate_limit_is_retried_once_and_then_succeeds() -> None:
    calls = {"n": 0}

    def handler(_request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(429, text="slow down") if calls["n"] == 1 else _ok([UNIT])

    asyncio.run(_embedder(handler).embed_query("drawdown"))

    assert calls["n"] == 2


def test_a_bad_key_is_not_retried() -> None:
    """A 401 returns the same answer however many times we ask."""
    calls = {"n": 0}

    def handler(_request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(401, text="no")

    with pytest.raises(EmbeddingError, match="401"):
        asyncio.run(_embedder(handler).embed_query("drawdown"))

    assert calls["n"] == 1


def test_embedding_no_texts_sends_no_request() -> None:
    """An empty `input` is a 400, and "embed nothing" is a legitimate ask."""

    def handler(_request: httpx.Request) -> httpx.Response:  # pragma: no cover
        raise AssertionError("no request should be made")

    assert asyncio.run(_embedder(handler).embed_documents([])) == []


# --------------------------------------------------------------------------
# The factory branch - the whole claim slice 2 made
# --------------------------------------------------------------------------


def test_the_factory_builds_the_paid_embedder_and_calls_it_semantic() -> None:
    settings = Settings(  # type: ignore[arg-type]
        _env_file=None, embeddings_provider="openrouter", openrouter_api_key="k"
    )

    embedder = build_embedder(settings)

    assert embedder.model == "openai/text-embedding-3-small"
    assert embedder.dimension == EMBEDDING_DIMENSION
    assert embedder.charges_per_token is True


def test_openrouter_without_a_key_refuses_rather_than_falling_back_to_fixture() -> None:
    """Falling back would embed a corpus with something nobody asked for.

    Same argument as an unknown provider name: there is no honest null
    embedding, and a corpus silently embedded by the fixture while the operator
    believes it is paid-for is worse than a refusal at boot.
    """
    settings = Settings(_env_file=None, embeddings_provider="openrouter")  # type: ignore[arg-type]

    with pytest.raises(EmbedderConfigurationError, match="OPENROUTER_API_KEY"):
        build_embedder(settings)


def test_the_configured_model_is_honoured() -> None:
    settings = Settings(  # type: ignore[arg-type]
        _env_file=None,
        embeddings_provider="openrouter",
        openrouter_api_key="k",
        embeddings_model="qwen/qwen3-embedding-8b",
    )

    assert build_embedder(settings).model == "qwen/qwen3-embedding-8b"
