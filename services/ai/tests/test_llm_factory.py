"""Provider selection from configuration.

The factory is the only place in the codebase that names a provider, so these
tests are what stops guideline 6 ("adding a provider must never touch a call
site") from quietly decaying. No call here reaches a network: an unconfigured
provider is resolved before any HTTP client is used, and the one configured case
is given a MockTransport.
"""

from __future__ import annotations

import httpx

from app.config import Settings
from app.llm.budget import BudgetedProvider
from app.llm.factory import build_llm
from app.llm.null_provider import NullProvider
from app.llm.openai_compatible import OpenAICompatibleProvider
from tests.fakes import FakeRedis


def build(**overrides) -> Settings:
    """Settings from arguments only; `_env_file=None` keeps a developer's keys out.

    Without it, whether this suite selects OpenRouter or Null depends on whether
    the machine running it happens to have a key in .env.
    """
    return Settings(_env_file=None, app_env="test", **overrides)


def _unwrap(provider) -> object:
    """The adapter inside the budget wrapper, for asserting on its configuration."""
    return provider._inner if isinstance(provider, BudgetedProvider) else provider


# -- selection ----------------------------------------------------------------


def test_openrouter_is_selected_when_a_key_is_present():
    provider = build_llm(
        build(llm_provider="openrouter", openrouter_api_key="sk-test"), FakeRedis()
    )

    assert isinstance(provider, BudgetedProvider)  # metered, so guarded
    adapter = _unwrap(provider)
    assert isinstance(adapter, OpenAICompatibleProvider)
    assert adapter.name == "openrouter"
    assert adapter.charges_per_token is True


def test_openai_is_selected_when_a_key_is_present():
    provider = build_llm(build(llm_provider="openai", openai_api_key="sk-test"), FakeRedis())
    assert _unwrap(provider).name == "openai"


def test_ollama_needs_no_key_and_no_budget_guard():
    # Local inference is not metered, so wrapping it in the spend guard would
    # mean a zero budget disabling a provider that cannot cost anything.
    provider = build_llm(build(llm_provider="ollama"), FakeRedis())

    assert isinstance(provider, OpenAICompatibleProvider)
    assert provider.charges_per_token is False
    assert provider.model == build().ollama_model


def test_the_ollama_base_url_gains_the_openai_compatibility_prefix():
    # OLLAMA_BASE_URL in .env.example is the root; the compatible surface is /v1.
    provider = build_llm(build(llm_provider="ollama", ollama_base_url="http://ollama:11434/"))
    assert provider._base_url == "http://ollama:11434/v1"
    already = build_llm(build(llm_provider="ollama", ollama_base_url="http://ollama:11434/v1"))
    assert already._base_url == "http://ollama:11434/v1"


def test_the_configured_model_and_limits_reach_the_adapter():
    adapter = _unwrap(
        build_llm(
            build(
                llm_provider="openrouter",
                openrouter_api_key="sk-test",
                llm_model="openai/gpt-4o-mini",
                llm_timeout_seconds=7.5,
                llm_max_output_tokens=321,
                llm_temperature=0.4,
            ),
            FakeRedis(),
        )
    )
    assert adapter.model == "openai/gpt-4o-mini"
    assert adapter._timeout_seconds == 7.5
    assert adapter._max_output_tokens == 321
    assert adapter._temperature == 0.4


# -- everything that degrades to no narration ---------------------------------


def test_a_missing_key_degrades_to_the_null_provider():
    # The system must run with no LLM credentials at all: CI has none, and a
    # fresh clone has none.
    provider = build_llm(build(llm_provider="openrouter", openrouter_api_key=None), FakeRedis())
    assert isinstance(provider, NullProvider)
    assert "OPENROUTER_API_KEY" in provider.reason


def test_an_explicit_null_provider_is_honoured():
    assert isinstance(build_llm(build(llm_provider="null"), FakeRedis()), NullProvider)


def test_an_unknown_provider_name_degrades_rather_than_guessing():
    provider = build_llm(build(llm_provider="mistral-direct"), FakeRedis())
    assert isinstance(provider, NullProvider)
    assert "mistral-direct" in provider.reason


def test_anthropic_is_a_documented_extension_point_not_a_silent_failure():
    # Anthropic's native /v1/messages needs its own adapter; its models are
    # reachable through OpenRouter in the meantime.
    provider = build_llm(build(llm_provider="anthropic", anthropic_api_key="sk-test"), FakeRedis())
    assert isinstance(provider, NullProvider)
    assert "Anthropic" in provider.reason


def test_a_metered_provider_without_redis_refuses_to_run_unguarded():
    # Fail closed: no counter means no way to enforce LLM_DAILY_BUDGET_USD.
    provider = build_llm(build(llm_provider="openrouter", openrouter_api_key="sk-test"), None)
    assert isinstance(provider, NullProvider)
    assert "spend cannot be tracked" in provider.reason


# -- the assembled object still works -----------------------------------------


async def test_the_factory_output_completes_a_call_end_to_end():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "model": "openai/gpt-4o-mini",
                "choices": [{"message": {"content": "VOO drifted 1.1% above target."}}],
                "usage": {"prompt_tokens": 800, "completion_tokens": 120},
            },
        )

    redis = FakeRedis()
    provider = build_llm(
        build(
            llm_provider="openrouter",
            openrouter_api_key="sk-test",
            llm_model="openai/gpt-4o-mini",
        ),
        redis,
        transport=httpx.MockTransport(handler),
    )

    result = await provider.complete(system="narrate", user="VOO +1.1%")

    assert result.text == "VOO drifted 1.1% above target."
    assert result.estimated_cost_micro_usd > 0
    # The spend landed in the day's counter, which is what makes the cap enforceable.
    assert await provider._guard.spent_micro_usd() == result.estimated_cost_micro_usd
