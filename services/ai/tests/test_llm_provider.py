"""The OpenAI-compatible adapter, its retry policy, and the null provider.

Every HTTP interaction goes through `httpx.MockTransport`, so the suite makes no
network call and needs no key. The retry backoff is set to zero in these tests:
the behaviour under test is "how many attempts", not "how long we wait".
"""

from __future__ import annotations

from decimal import Decimal

import httpx
import pytest

from app.llm.base import (
    LLMRequestError,
    LLMTimeoutError,
    LLMUnavailableError,
    TokenUsage,
)
from app.llm.null_provider import NullProvider
from app.llm.openai_compatible import OpenAICompatibleProvider
from app.llm.pricing import ModelPrice, estimate_cost_micro_usd

MODEL = "anthropic/claude-sonnet-4.5"
PRICES = {MODEL: ModelPrice(Decimal("3"), Decimal("15"))}


def _body(text: str = "AAPL fell 3.2% on the quarterly guidance cut.") -> dict:
    return {
        "model": MODEL,
        "choices": [{"message": {"role": "assistant", "content": text}}],
        "usage": {"prompt_tokens": 1200, "completion_tokens": 300},
    }


def _provider(handler, **overrides) -> OpenAICompatibleProvider:
    options = {
        "name": "openrouter",
        "base_url": "https://openrouter.test/api/v1",
        "model": MODEL,
        "api_key": "test-key",
        "prices": PRICES,
        "retry_backoff_seconds": 0.0,
        "transport": httpx.MockTransport(handler),
    }
    options.update(overrides)
    return OpenAICompatibleProvider(**options)


# -- the happy path -----------------------------------------------------------


async def test_a_successful_completion_is_parsed_with_usage_and_cost():
    provider = _provider(lambda request: httpx.Response(200, json=_body()))

    result = await provider.complete(system="You narrate findings.", user="AAPL -3.2%")

    assert result.text == "AAPL fell 3.2% on the quarterly guidance cut."
    assert result.model == MODEL
    assert result.usage == TokenUsage(prompt_tokens=1200, completion_tokens=300)
    assert result.provider == "openrouter"
    # Asserted against the pricing function rather than a hand-computed number,
    # so retuning a price cannot fail a test about parsing.
    assert result.estimated_cost_micro_usd == estimate_cost_micro_usd(MODEL, result.usage, PRICES)


async def test_the_request_carries_the_prompts_model_and_credential():
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["authorization"] = request.headers.get("authorization")
        seen["json"] = httpx.Response(200, content=request.content).json()
        return httpx.Response(200, json=_body())

    await _provider(handler).complete(
        system="rules", user="finding", max_output_tokens=123, temperature=0.0
    )

    assert seen["url"] == "https://openrouter.test/api/v1/chat/completions"
    assert seen["authorization"] == "Bearer test-key"
    payload = seen["json"]
    assert payload["model"] == MODEL
    assert payload["messages"] == [
        {"role": "system", "content": "rules"},
        {"role": "user", "content": "finding"},
    ]
    assert payload["max_tokens"] == 123
    assert payload["temperature"] == 0.0
    assert payload["stream"] is False


async def test_the_served_model_wins_over_the_requested_one():
    # OpenRouter may route to a different upstream than the one asked for; cost
    # and logs must describe what actually ran.
    served = {**_body(), "model": "anthropic/claude-haiku-4.5"}
    result = await _provider(lambda request: httpx.Response(200, json=served)).complete(
        system=None, user="finding"
    )
    assert result.model == "anthropic/claude-haiku-4.5"


async def test_a_system_prompt_is_optional():
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["json"] = httpx.Response(200, content=request.content).json()
        return httpx.Response(200, json=_body())

    await _provider(handler).complete(system=None, user="finding")
    assert seen["json"]["messages"] == [{"role": "user", "content": "finding"}]


# -- retry policy -------------------------------------------------------------


async def test_a_429_is_retried_once_and_then_succeeds():
    attempts: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        attempts.append(1)
        if len(attempts) == 1:
            return httpx.Response(429, json={"error": "slow down"})
        return httpx.Response(200, json=_body())

    result = await _provider(handler).complete(system=None, user="finding")

    assert len(attempts) == 2
    assert result.text.startswith("AAPL fell")


async def test_a_500_is_retried_once_and_then_fails_with_a_typed_error():
    attempts: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        attempts.append(1)
        return httpx.Response(500, json={"error": "upstream exploded"})

    with pytest.raises(LLMRequestError) as raised:
        await _provider(handler).complete(system=None, user="finding")

    assert len(attempts) == 2  # one attempt, one retry, then give up
    assert raised.value.status_code == 500


async def test_a_400_is_not_retried():
    # A malformed request, a revoked key or a missing model answers the same way
    # however often we ask, so a retry spends latency and possibly money for
    # nothing.
    attempts: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        attempts.append(1)
        return httpx.Response(400, json={"error": "no such model"})

    with pytest.raises(LLMRequestError) as raised:
        await _provider(handler).complete(system=None, user="finding")

    assert len(attempts) == 1
    assert raised.value.status_code == 400


@pytest.mark.parametrize("status", [401, 403, 404, 422])
async def test_no_client_error_is_retried(status: int):
    attempts: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        attempts.append(1)
        return httpx.Response(status, json={"error": "nope"})

    with pytest.raises(LLMRequestError):
        await _provider(handler).complete(system=None, user="finding")
    assert len(attempts) == 1


async def test_a_retry_after_header_is_capped_rather_than_obeyed():
    # A gateway asking for a two-minute wait is asking us to hold a scheduled run
    # open; narration is not worth that.
    provider = _provider(lambda request: httpx.Response(200, json=_body()))
    delay = provider._retry_delay(httpx.Response(429, headers={"retry-after": "120"}))
    from app.llm.openai_compatible import _MAX_RETRY_AFTER_SECONDS

    assert delay == _MAX_RETRY_AFTER_SECONDS


async def test_a_timeout_raises_a_typed_error_and_is_not_retried():
    attempts: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        attempts.append(1)
        raise httpx.ReadTimeout("too slow", request=request)

    with pytest.raises(LLMTimeoutError):
        await _provider(handler, timeout_seconds=0.5).complete(system=None, user="finding")

    assert len(attempts) == 1


async def test_a_transport_failure_is_reported_as_a_request_error():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route to host", request=request)

    with pytest.raises(LLMRequestError):
        await _provider(handler).complete(system=None, user="finding")


# -- unusable answers ---------------------------------------------------------


async def test_an_empty_completion_fails_and_carries_the_tokens_it_burned():
    empty = {**_body(), "choices": [{"message": {"content": "   "}}]}

    with pytest.raises(LLMRequestError) as raised:
        await _provider(lambda request: httpx.Response(200, json=empty)).complete(
            system=None, user="finding"
        )

    # The prompt was billed even though nothing came back, so the charge travels
    # with the error for the budget guard to record.
    assert raised.value.metered_micro_usd > 0


async def test_a_non_json_body_fails_cleanly():
    provider = _provider(lambda request: httpx.Response(200, text="<html>bad gateway</html>"))
    with pytest.raises(LLMRequestError):
        await provider.complete(system=None, user="finding")


async def test_a_response_without_usage_is_still_usable():
    # A gateway that omits usage must not crash the call; the cost estimate is
    # simply zero and the log line shows why.
    no_usage = {"model": MODEL, "choices": [{"message": {"content": "text"}}]}
    result = await _provider(lambda request: httpx.Response(200, json=no_usage)).complete(
        system=None, user="finding"
    )
    assert result.usage.total_tokens == 0
    assert result.estimated_cost_micro_usd == 0


# -- the null provider --------------------------------------------------------


async def test_the_null_provider_refuses_with_a_typed_error_and_a_reason():
    provider = NullProvider("OPENROUTER_API_KEY is not set")

    with pytest.raises(LLMUnavailableError, match="OPENROUTER_API_KEY"):
        await provider.complete(system=None, user="finding")


def test_the_null_provider_is_never_billed():
    assert NullProvider().charges_per_token is False
