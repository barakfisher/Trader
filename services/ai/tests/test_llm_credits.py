"""The provider account's balance, for the Admin page (D44)."""

from __future__ import annotations

from decimal import Decimal

import httpx

from app.config import Settings
from app.llm.credits import OpenRouterCredits, build_credit_source


def _source(handler) -> OpenRouterCredits:
    return OpenRouterCredits(
        "https://openrouter.test/api/v1", "test-key", transport=httpx.MockTransport(handler)
    )


async def test_the_balance_is_what_was_bought_less_what_was_used():
    seen: dict[str, str | None] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["authorization"] = request.headers.get("authorization")
        return httpx.Response(200, json={"data": {"total_credits": 10, "total_usage": 0.25}})

    credits = await _source(handler).credits()
    assert credits is not None
    assert (credits.purchased_usd, credits.used_usd) == (Decimal("10"), Decimal("0.25"))
    assert credits.remaining_usd == Decimal("9.75")
    assert seen == {
        "url": "https://openrouter.test/api/v1/credits",
        "authorization": "Bearer test-key",
    }


async def test_an_unreadable_balance_is_unavailable_not_zero():
    assert await _source(lambda request: httpx.Response(500)).credits() is None
    assert await _source(lambda request: httpx.Response(200, json={"x": 1})).credits() is None


def test_only_openrouter_with_a_key_reports_a_balance():
    def settings(**overrides) -> Settings:
        return Settings(_env_file=None, app_env="test", **overrides)

    assert build_credit_source(settings(llm_provider="openrouter", openrouter_api_key="k"))
    assert build_credit_source(settings(llm_provider="openrouter", openrouter_api_key=None)) is None
    assert build_credit_source(settings(llm_provider="ollama")) is None
