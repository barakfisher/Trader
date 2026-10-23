"""The models a user may choose: OpenRouter's own list, filtered (D283).

`GET /api/v1/models` is public (no key) and lists every model with its price
per token. A user on their own key chooses from it (D244), so the list is read
here, filtered to what this app can use, and kept in memory for
`OFFERED_MODELS_TTL_SECONDS`. Measured 2026-10-23: 468 listed, about 370 kept.

**What is kept** (`offerable`): a model that calls tools - every scope's caller
may (scans, the assistant) - with a fixed, positive price, no announced
`expiration_date`, and text in and out. Not kept: `:free` routes (narration's
free route was refused 56% of the time on compose, and agents were never offered
one, `catalogue.py`), negative prices (OpenRouter's routers, whose price is
whatever they route to), and `~` aliases ("the latest Sonnet"), which move to a
new model and a new price without the id changing.

**Its prices price the call.** A listed model's prompt and completion prices
are written into the shared `PriceBook` (`pricing.py`) on every refresh, so its
calls and the safety limit's pre-call ceiling count it at the price OpenRouter
bills, not at the pessimistic unknown-model rate.

**A failed read keeps the last good list** and is retried after
`RETRY_AFTER_FAILURE_SECONDS`, so an outage costs one slow call in five minutes,
not one per call. With no list read yet, the Admin page's catalogue stands in,
priced by the table, and is marked `live = False`: callers then cannot tell a
model is gone, and use a saved one as it is (D284).

In memory per process rather than in Redis: the list is public and the same for
everyone, so two pods an hour apart disagree at most about a model added or
retired in that hour.
"""

from __future__ import annotations

import asyncio
import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any

import httpx

from app.core.logging import get_logger
from app.llm.catalogue import CATALOGUE
from app.llm.pricing import ModelPrice, PriceBook, is_declared_free, price_for

log = get_logger("llm.openrouter_models")

#: How long one reading of OpenRouter's list is offered before it is read again.
OFFERED_MODELS_TTL_SECONDS = 60 * 60
#: After a failed read, how long the last good list (or the stand-in) is kept
#: before OpenRouter is asked again.
RETRY_AFTER_FAILURE_SECONDS = 5 * 60

_FETCH_TIMEOUT_SECONDS = 10.0
_TOKENS_PER_MILLION = Decimal(1_000_000)

#: An id a call can send and the database accepts (migration 0069's CHECK).
MODEL_ID = re.compile(r"[a-z0-9][a-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._:-]*")


@dataclass(frozen=True)
class ListedModel:
    id: str
    name: str
    price: ModelPrice


@dataclass(frozen=True)
class ModelList:
    """The models a user may choose, in OpenRouter's order.

    `live` is False for the catalogue standing in before any read succeeded:
    whether a saved model is still listed is then unknown.
    """

    models: tuple[ListedModel, ...]
    live: bool
    _by_id: dict[str, ListedModel] = field(init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        object.__setattr__(self, "_by_id", {model.id: model for model in self.models})

    def get(self, model_id: str) -> ListedModel | None:
        return self._by_id.get(model_id)


def _per_mtok(value: object) -> Decimal | None:
    """OpenRouter's USD-per-token string, as USD per million tokens; None unless finite."""
    if not isinstance(value, str):
        return None
    try:
        price = Decimal(value)
    except InvalidOperation:
        return None
    # "NaN" and "Infinity" parse, and then break every comparison and sum after them.
    return price * _TOKENS_PER_MILLION if price.is_finite() else None


def _strings(value: object) -> list[str]:
    return [item for item in value if isinstance(item, str)] if isinstance(value, list) else []


def _object(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def offerable(entry: Any) -> ListedModel | None:
    """The entry as a model a user may choose, or None when it may not be.

    Third-party data: every field is checked for its type before it is read, so
    one oddly shaped entry is skipped rather than failing the whole list.
    """
    if not isinstance(entry, dict):
        return None
    model_id = entry.get("id")
    if not isinstance(model_id, str) or not MODEL_ID.fullmatch(model_id):
        return None
    if is_declared_free(model_id):
        return None
    if entry.get("expiration_date"):
        return None
    if "tools" not in _strings(entry.get("supported_parameters")):
        return None
    architecture = _object(entry.get("architecture"))
    if "text" not in _strings(architecture.get("input_modalities")) or "text" not in _strings(
        architecture.get("output_modalities")
    ):
        return None
    pricing = _object(entry.get("pricing"))
    prompt = _per_mtok(pricing.get("prompt"))
    completion = _per_mtok(pricing.get("completion"))
    if prompt is None or completion is None or prompt <= 0 or completion <= 0:
        return None
    # Only prompt and completion tokens are counted against the safety limit, so a
    # model billed by the request, or for reasoning at a price of its own, would
    # be counted low. None was listed on 2026-10-23; one that appears is not offered.
    request = pricing.get("request")
    if request is not None and _per_mtok(request) != 0:
        return None
    reasoning = pricing.get("internal_reasoning")
    if reasoning is not None and _per_mtok(reasoning) != completion:
        return None
    name = entry.get("name")
    return ListedModel(
        id=model_id,
        name=name if isinstance(name, str) and name.strip() else model_id,
        price=ModelPrice(prompt, completion),
    )


def stand_in(prices: dict[str, ModelPrice]) -> ModelList:
    """The Admin page's billed, tool-calling models, until OpenRouter's list is read."""
    models = []
    for model in CATALOGUE:
        price = price_for(model.id, prices)
        if model.supports_tools and not is_declared_free(model.id) and price is not None:
            models.append(ListedModel(id=model.id, name=model.label, price=price))
    return ModelList(models=tuple(models), live=False)


def _safely_offerable(entry: Any) -> ListedModel | None:
    try:
        return offerable(entry)
    except Exception as error:  # noqa: BLE001 - one bad entry must not lose the list
        log.warning("llm.model_list_entry_skipped", error=type(error).__name__)
        return None


class OpenRouterModels:
    """OpenRouter's model list, read at most once per `OFFERED_MODELS_TTL_SECONDS`."""

    def __init__(
        self,
        base_url: str,
        prices: PriceBook,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._url = f"{base_url.rstrip('/')}/models"
        self._prices = prices
        self._transport = transport
        self._clock = clock
        self._list: ModelList | None = None
        self._next_read_at = 0.0
        self._lock = asyncio.Lock()

    @property
    def prices(self) -> PriceBook:
        """The book this list writes its prices into, and every call is charged from."""
        return self._prices

    def snapshot(self) -> ModelList:
        """The list as last read, without reading: the stand-in before the first read."""
        return self._list or stand_in(self._prices)

    async def current(self) -> ModelList:
        """The list, read again first when it is due. Never raises."""
        if self._clock() >= self._next_read_at:
            async with self._lock:
                # Another caller may have read it while this one waited.
                if self._clock() >= self._next_read_at:
                    await self._read()
        return self.snapshot()

    async def _read(self) -> None:
        try:
            async with httpx.AsyncClient(
                timeout=_FETCH_TIMEOUT_SECONDS, transport=self._transport
            ) as client:
                response = await client.get(self._url)
            response.raise_for_status()
            entries = response.json()["data"]
            if not isinstance(entries, list):
                raise TypeError("data is not a list")
        except (httpx.HTTPError, KeyError, TypeError, ValueError) as error:
            log.warning("llm.model_list_unreadable", error=type(error).__name__)
            self._next_read_at = self._clock() + RETRY_AFTER_FAILURE_SECONDS
            return
        models = tuple(model for model in map(_safely_offerable, entries) if model is not None)
        if not models:
            # An empty list is a broken answer, not "every model is gone": keeping
            # the last good one stops every saved choice falling back at once.
            log.warning("llm.model_list_empty", listed=len(entries))
            self._next_read_at = self._clock() + RETRY_AFTER_FAILURE_SECONDS
            return
        self._list = ModelList(models=models, live=True)
        self._prices.use_listed({model.id: model.price for model in models})
        self._next_read_at = self._clock() + OFFERED_MODELS_TTL_SECONDS
        log.info("llm.model_list_read", listed=len(entries), offered=len(models))
