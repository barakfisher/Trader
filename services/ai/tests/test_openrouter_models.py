"""OpenRouter's model list, filtered to what a user may choose, and its prices (D282)."""

from __future__ import annotations

from decimal import Decimal

import httpx

from app.llm.catalogue import CATALOGUE
from app.llm.openrouter_models import (
    OFFERED_MODELS_TTL_SECONDS,
    RETRY_AFTER_FAILURE_SECONDS,
    OpenRouterModels,
    offerable,
    stand_in,
)
from app.llm.pricing import DEFAULT_MODEL_PRICES, ModelPrice, PriceBook, price_for


def entry(model_id: str = "acme/model-1", **overrides) -> dict:
    body = {
        "id": model_id,
        "name": "Acme: Model 1",
        "pricing": {"prompt": "0.0000001", "completion": "0.0000004"},
        "supported_parameters": ["tools", "temperature"],
        "architecture": {"input_modalities": ["text"], "output_modalities": ["text"]},
        "expiration_date": None,
    }
    body.update(overrides)
    return body


def test_a_billed_tool_calling_text_model_is_offered_at_its_price_per_million():
    model = offerable(entry())
    assert model is not None
    assert model.id == "acme/model-1" and model.name == "Acme: Model 1"
    assert model.price == ModelPrice(Decimal("0.1"), Decimal("0.4"))


def test_what_is_not_offered():
    refused = {
        "free route": entry("acme/model-1:free"),
        "alias": entry("~acme/model-latest"),
        "no tools": entry(supported_parameters=["temperature"]),
        "expiring": entry(expiration_date="2026-11-01"),
        "variable price": entry(pricing={"prompt": "-1", "completion": "-1"}),
        "zero price": entry(pricing={"prompt": "0", "completion": "0"}),
        "unparseable price": entry(pricing={"prompt": "n/a", "completion": "0.1"}),
        "image out": entry(
            architecture={"input_modalities": ["text"], "output_modalities": ["image"]}
        ),
        "not a dict": "acme/model-1",
        "NaN price": entry(pricing={"prompt": "NaN", "completion": "0.1"}),
        "infinite price": entry(pricing={"prompt": "0.1", "completion": "Infinity"}),
        "pricing not an object": entry(pricing="cheap"),
        "architecture not an object": entry(architecture="text"),
        "parameters not a list": entry(supported_parameters=7),
        "billed by the request": entry(
            pricing={"prompt": "0.0000001", "completion": "0.0000004", "request": "0.01"}
        ),
        "reasoning priced apart": entry(
            pricing={
                "prompt": "0.0000001",
                "completion": "0.0000004",
                "internal_reasoning": "0.000001",
            }
        ),
    }
    for reason, body in refused.items():
        assert offerable(body) is None, reason


def _transport(responses: list[httpx.Response]) -> tuple[httpx.MockTransport, list[str]]:
    asked: list[str] = []

    def handle(request: httpx.Request) -> httpx.Response:
        asked.append(str(request.url))
        return responses.pop(0)

    return httpx.MockTransport(handle), asked


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


async def test_the_list_is_read_once_per_ttl_and_its_prices_reach_the_price_book():
    prices = PriceBook()
    transport, asked = _transport(
        [
            httpx.Response(200, json={"data": [entry(), entry("acme/model-2:free")]}),
            httpx.Response(200, json={"data": [entry("acme/model-3")]}),
        ]
    )
    clock = Clock()
    listed = OpenRouterModels(
        "https://openrouter.test/api/v1", prices, transport=transport, clock=clock
    )

    first = await listed.current()
    assert first.live and [m.id for m in first.models] == ["acme/model-1"]
    assert asked == ["https://openrouter.test/api/v1/models"]
    assert price_for("acme/model-1", prices) == ModelPrice(Decimal("0.1"), Decimal("0.4"))

    clock.now += OFFERED_MODELS_TTL_SECONDS - 1
    await listed.current()
    assert len(asked) == 1

    clock.now += 1
    second = await listed.current()
    assert [m.id for m in second.models] == ["acme/model-3"] and len(asked) == 2


async def test_a_failed_read_keeps_the_last_good_list_and_waits_before_asking_again():
    transport, asked = _transport(
        [
            httpx.Response(200, json={"data": [entry()]}),
            httpx.Response(503),
            httpx.Response(200, json={"data": []}),
            httpx.Response(200, json={"data": [entry("acme/model-3")]}),
        ]
    )
    clock = Clock()
    listed = OpenRouterModels("https://x/api/v1", PriceBook(), transport=transport, clock=clock)
    await listed.current()

    clock.now += OFFERED_MODELS_TTL_SECONDS
    assert [m.id for m in (await listed.current()).models] == ["acme/model-1"]
    clock.now += RETRY_AFTER_FAILURE_SECONDS - 1
    await listed.current()
    assert len(asked) == 2

    # An empty answer is a broken one, not "every model is gone".
    clock.now += 1
    assert [m.id for m in (await listed.current()).models] == ["acme/model-1"]
    clock.now += RETRY_AFTER_FAILURE_SECONDS
    assert [m.id for m in (await listed.current()).models] == ["acme/model-3"]


async def test_before_any_read_succeeds_the_catalogue_stands_in_and_is_not_live():
    transport, _ = _transport([httpx.Response(500)])
    listed = OpenRouterModels("https://x/api/v1", PriceBook(), transport=transport, clock=Clock())
    current = await listed.current()
    assert not current.live
    assert current == stand_in(DEFAULT_MODEL_PRICES)
    billed_tool_models = [
        m.id for m in CATALOGUE if m.supports_tools and not m.id.endswith(":free")
    ]
    assert [m.id for m in current.models] == billed_tool_models


def test_configured_prices_overrule_listed_ones_and_listed_ones_the_defaults():
    model = "google/gemini-3.5-flash-lite"
    prices = PriceBook("acme/model-1=9/9")
    prices.use_listed(
        {
            "acme/model-1": ModelPrice(Decimal("1"), Decimal("1")),
            model: ModelPrice(Decimal("5"), Decimal("5")),
        }
    )
    assert prices["acme/model-1"] == ModelPrice(Decimal("9"), Decimal("9"))
    assert prices[model] == ModelPrice(Decimal("5"), Decimal("5"))
    assert prices["anthropic/claude-opus-5.5"] == DEFAULT_MODEL_PRICES["anthropic/claude-opus-5.5"]


async def test_one_oddly_shaped_entry_is_skipped_and_the_rest_of_the_list_kept():
    odd = {"id": "acme/odd", "pricing": {"prompt": object()}}
    transport, _ = _transport(
        [httpx.Response(200, json={"data": [entry(), entry("acme/x", pricing=[1])]})]
    )
    listed = OpenRouterModels("https://x/api/v1", PriceBook(), transport=transport, clock=Clock())
    assert [m.id for m in (await listed.current()).models] == ["acme/model-1"]
    assert offerable(odd) is None
