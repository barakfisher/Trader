"""The paid embedder: OpenAI's `/embeddings` shape, reached through OpenRouter.

This is the migration slice 2 recorded as owed, and it arrived earlier than
planned because the reason it was deferred turned out to be wrong. MEMORY.md had
it blocked behind the same OpenRouter spend cap as narration. The two differ by
four orders of magnitude: narration is ~$0.45/month against a **lifetime** $0.01
budget, while embedding the entire 36-chunk corpus is **5,792 tokens** at
$0.02/1M — about **one hundredth of a cent**, once, or roughly one eighty-sixth
of the cap it was supposedly blocked by. Per-query embedding is ten tokens.
→ The lesson worth keeping: **"blocked on X" is inherited, not verified.** That
sentence sat in MEMORY.md for two sessions and a one-line arithmetic check
dissolved it.

**A separate adapter from `llm/openai_compatible.py`, not a flag on it.**
`/embeddings` and `/chat/completions` share a host, a credential and an auth
header, and nothing else that matters: the request carries `input` rather than
`messages`, the response is a list of vectors rather than a choice, there is no
streaming, no temperature and no reasoning, and the failure a caller cares about
is a different type. Folding two shapes into one class to share a base URL would
put a branch on every method to save a constructor argument.

**The width is verified on arrival rather than requested.** OpenAI's
`/embeddings` accepts a `dimensions` parameter, and it is deliberately not sent:
only the `text-embedding-3-*` family supports it, so sending it unconditionally
makes any other model a hard failure, and sending it conditionally means a
heuristic over model names — which this codebase already regrets once, in
`cache_policy.py`'s `-USD` crypto detection. Instead every response is checked
against `EMBEDDING_DIMENSION` and a mismatch raises with **both** numbers and the
model named, because the only fix is a decision (change the model, or migrate the
column) and the person making it needs to see what it currently is.
→ The consequence to know: **switching to `text-embedding-3-large` needs
`"dimensions": 1536` added to the payload here.** It is natively 3072 wide, and
without that line it will fail this check on its first call rather than corrupt
anything — which is the intended direction.

**No daily spend guard, and that is a decision rather than an omission.**
`llm/budget.py` exists because narration runs unattended every thirty minutes at
roughly a cent a call, so an unnoticed loop is a real bill. Embedding is not that
shape: it is idempotent, it runs only over chunks whose text changed, a full
corpus re-embed costs a hundredth of a cent, and a query is ten tokens. A guard
would add a Redis dependency to the ingester — which currently needs only
Postgres — to protect against a sum that cannot reach a cent in a year. What is
kept is the *visibility* the guard is really for: every call logs its token count
and estimated cost, so the number is observable if it ever stops being trivial.
"""

from __future__ import annotations

import asyncio
import math
from decimal import Decimal
from typing import Any

import httpx

from app.core.logging import get_logger
from app.corpus.embeddings import EMBEDDING_DIMENSION, Embedding, EmbeddingError

log = get_logger("corpus.openrouter_embedder")

#: Published price for `openai/text-embedding-3-small`, in USD per million
#: tokens. Local and approximate, exactly like `llm/pricing.py`: the endpoint
#: returns a token count and never a billed amount, so this is spend telemetry
#: and never an invoice.
DEFAULT_PRICE_USD_PER_MTOK = Decimal("0.02")

#: One retry, on rate limiting and server faults only. Deliberately the same
#: policy as `llm/openai_compatible.py`, and deliberately *not* shared with it:
#: two copies of a short loop cost less than a base class whose only member is a
#: retry, and the two will diverge the moment either endpoint needs different
#: behaviour. If a third caller ever wants this, extract it then.
_RETRYABLE_STATUS = frozenset({429, 500, 502, 503, 504, 529})


class OpenRouterEmbedder:
    """`BaseEmbedder` over an OpenAI-compatible `/embeddings` endpoint."""

    charges_per_token = True

    def __init__(
        self,
        *,
        model: str,
        base_url: str,
        api_key: str,
        dimension: int = EMBEDDING_DIMENSION,
        timeout_seconds: float = 30.0,
        price_usd_per_mtok: Decimal = DEFAULT_PRICE_USD_PER_MTOK,
        retry_backoff_seconds: float = 1.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.model = model
        self.dimension = dimension
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._timeout_seconds = timeout_seconds
        self._price_usd_per_mtok = price_usd_per_mtok
        self._retry_backoff_seconds = retry_backoff_seconds
        # Injected by tests as an httpx.MockTransport, which keeps the suite
        # offline and keyless without a mocking library.
        self._transport = transport

    def _headers(self) -> dict[str, str]:
        return {
            "content-type": "application/json",
            # Never logged. The log lines in this module carry the model, a
            # token count and a cost, and nothing that could carry a credential
            # (guideline 9).
            "authorization": f"Bearer {self._api_key}",
            "x-title": "Traders",
        }

    async def embed_documents(self, texts: list[str]) -> list[Embedding]:
        if not texts:
            # No request at all. An empty `input` is a 400 from the endpoint,
            # and "embed nothing" is a legitimate thing for a caller to ask
            # after a no-op ingest.
            return []
        return await self._embed(texts)

    async def embed_query(self, text: str) -> Embedding:
        return (await self._embed([text]))[0]

    async def _embed(self, texts: list[str]) -> list[Embedding]:
        payload: dict[str, Any] = {"model": self.model, "input": texts}
        data = await self._post_with_one_retry(payload)
        return self._parse(data, expected=len(texts))

    async def _post_with_one_retry(self, payload: dict[str, Any]) -> dict[str, Any]:
        url = f"{self._base_url}/embeddings"

        async with httpx.AsyncClient(
            timeout=httpx.Timeout(self._timeout_seconds),
            transport=self._transport,
            headers=self._headers(),
        ) as client:
            for attempt in (1, 2):
                try:
                    response = await client.post(url, json=payload)
                except httpx.TimeoutException as error:
                    raise EmbeddingError(
                        f"{self.model}: no response within {self._timeout_seconds}s"
                    ) from error
                except httpx.HTTPError as error:
                    raise EmbeddingError(f"{self.model}: {error}") from error

                if response.status_code < 400:
                    return response.json()  # type: ignore[no-any-return]

                # A 4xx that is not a rate limit will not fix itself: a revoked
                # key, a model that does not exist or a malformed body returns
                # the same answer however many times we ask.
                if attempt == 2 or response.status_code not in _RETRYABLE_STATUS:
                    raise EmbeddingError(
                        f"{self.model}: embeddings endpoint returned "
                        f"{response.status_code}: {response.text[:200]}"
                    )

                log.warning(
                    "corpus.embedder_retry",
                    model=self.model,
                    status=response.status_code,
                    inputs=len(payload["input"]),
                )
                await asyncio.sleep(self._retry_backoff_seconds)

        raise EmbeddingError(f"{self.model}: exhausted retries")  # pragma: no cover

    def _parse(self, data: dict[str, Any], *, expected: int) -> list[Embedding]:
        items = data.get("data")
        if not isinstance(items, list):
            raise EmbeddingError(f"{self.model}: response has no `data` list")

        # The endpoint documents `index` on each item and is not obliged to
        # return them in order. Sorting costs nothing and removes a silent
        # misattribution - every chunk after a transposition would be stored
        # under its neighbour's vector, which nothing downstream could tell from
        # a merely bad embedding model.
        try:
            items = sorted(items, key=lambda item: item["index"])
        except (KeyError, TypeError) as error:
            raise EmbeddingError(f"{self.model}: response items have no usable `index`") from error

        if len(items) != expected:
            # `ingest.py` checks this too, and the duplication is intended: that
            # check defends the zip against any provider, this one names the
            # endpoint that broke its contract.
            raise EmbeddingError(
                f"{self.model}: returned {len(items)} embeddings for {expected} inputs"
            )

        vectors: list[Embedding] = []
        for item in items:
            vector = item.get("embedding")
            if not isinstance(vector, list):
                raise EmbeddingError(f"{self.model}: an item carries no `embedding` list")
            if len(vector) != self.dimension:
                raise EmbeddingError(
                    f"{self.model}: returned {len(vector)}-dimensional vectors, but "
                    f"kb_chunks.embedding is vector({self.dimension}). Either point "
                    f"EMBEDDINGS_MODEL at a {self.dimension}-wide model, or add "
                    f'"dimensions": {self.dimension} to the request if this model '
                    f"supports truncation."
                )
            vectors.append(_normalised([float(component) for component in vector]))

        self._log_usage(data, inputs=expected)
        return vectors

    def _log_usage(self, data: dict[str, Any], *, inputs: int) -> None:
        usage = data.get("usage") or {}
        tokens = int(usage.get("prompt_tokens") or usage.get("total_tokens") or 0)
        cost = (Decimal(tokens) / Decimal(1_000_000)) * self._price_usd_per_mtok
        log.info(
            "corpus.embedded",
            model=self.model,
            inputs=inputs,
            tokens=tokens,
            # A string, not a float: it is money, and guideline 3 does not stop
            # applying because the amount is small.
            estimated_cost_usd=str(cost),
        )


def _normalised(vector: Embedding) -> Embedding:
    """Scale to unit length, which `BaseEmbedder` requires of every provider.

    OpenAI's embeddings already arrive normalised, so this is almost always a
    no-op — and it is done anyway because the index is built with
    `vector_cosine_ops` and the contract says unit length. A provider that
    quietly stopped normalising would not fail; it would rank slightly wrong,
    which is the failure mode this repository spends most of its effort making
    impossible.

    A zero vector cannot be normalised and must never be stored: pgvector's
    cosine distance against one is undefined, and NaN sorts unpredictably rather
    than failing. It is refused rather than substituted, because unlike the
    fixture embedder — which meets this case on genuinely empty text — a paid
    endpoint returning a zero vector means something is wrong upstream.
    """
    norm = math.sqrt(sum(component * component for component in vector))
    if norm == 0.0:
        raise EmbeddingError("the endpoint returned a zero vector, which has no direction")
    return [component / norm for component in vector]
