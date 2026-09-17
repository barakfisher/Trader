"""Cost estimation and the configurable price table.

The numbers here are estimates by construction (no OpenAI-compatible endpoint
reports a billed amount), so what is tested is the arithmetic, the direction of
rounding, and above all that an unpriced model is never free.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from app.config import Settings
from app.llm.base import MICRO_USD_PER_USD, TokenUsage, micro_usd_to_usd
from app.llm.pricing import (
    DEFAULT_MODEL_PRICES,
    FREE_MODEL_PRICE,
    ModelPrice,
    estimate_cost_micro_usd,
    parse_model_prices,
    price_for,
)

PRICES = {"test/model": ModelPrice(Decimal("3"), Decimal("15"))}


def build(**overrides) -> Settings:
    """Settings from arguments only; `_env_file=None` keeps the developer's .env out."""
    return Settings(_env_file=None, **overrides)


# -- arithmetic ---------------------------------------------------------------


def test_prompt_and_completion_tokens_are_priced_separately():
    usage = TokenUsage(prompt_tokens=1_000_000, completion_tokens=1_000_000)
    cost = estimate_cost_micro_usd("test/model", usage, PRICES)
    assert micro_usd_to_usd(cost) == Decimal("18")


def test_a_small_call_costs_a_fraction_of_a_cent():
    # The reason spend is counted in micro-USD rather than in cents: this call
    # would round to 1 cent or to 0, and both are wrong by a lot at scale.
    usage = TokenUsage(prompt_tokens=1_200, completion_tokens=300)
    assert estimate_cost_micro_usd("test/model", usage, PRICES) == 8_100


def test_the_estimate_rounds_up():
    # Rounding up over-reports spend, which is the safe direction for a guard.
    usage = TokenUsage(prompt_tokens=1, completion_tokens=0)
    assert estimate_cost_micro_usd("test/model", usage, PRICES) == 3


def test_no_tokens_cost_nothing():
    assert estimate_cost_micro_usd("test/model", TokenUsage(), PRICES) == 0


# -- models the gateway declares free -----------------------------------------


def test_a_free_route_costs_nothing_however_many_tokens_it_uses():
    # The counterpart to the unpriced-model rule above: `:free` is a price
    # stated by the party that bills, so charging the pessimistic rate for it
    # would empty the daily budget against spend that never happened.
    usage = TokenUsage(prompt_tokens=1_000_000, completion_tokens=1_000_000)
    assert estimate_cost_micro_usd("nvidia/some-model:free", usage, PRICES) == 0


def test_a_free_route_is_not_priced_from_its_paid_twin():
    # Without this, the prefix fallback in price_for would find "test/model"
    # for "test/model:free" and bill a free route at the paid rate.
    prices = {"test/model": ModelPrice(Decimal("3"), Decimal("15"))}
    assert price_for("test/model:free", prices) == FREE_MODEL_PRICE


def test_a_configured_price_cannot_make_a_free_route_cost_money():
    # A stale LLM_MODEL_PRICES entry must not resurrect a charge for a route
    # the gateway serves for nothing.
    prices = parse_model_prices("test/model:free=3/15")
    assert price_for("test/model:free", prices) == FREE_MODEL_PRICE


def test_the_free_suffix_is_recognised_whatever_the_casing():
    assert price_for("NVIDIA/Some-Model:FREE", PRICES) == FREE_MODEL_PRICE


def test_a_model_merely_named_free_is_still_priced():
    # The suffix is the declaration, not the word. "freeform/model" is a normal
    # model id and must fall through to the pessimistic unpriced rate.
    usage = TokenUsage(prompt_tokens=1_000_000, completion_tokens=0)
    assert estimate_cost_micro_usd("freeform/model", usage, PRICES) > 0


# -- unpriced models ----------------------------------------------------------


def test_an_unpriced_model_is_charged_a_pessimistic_rate_not_zero():
    usage = TokenUsage(prompt_tokens=1_000_000, completion_tokens=0)
    cost = estimate_cost_micro_usd(
        "someone/brand-new-model", usage, PRICES, unknown_price_usd_per_mtok=Decimal("20")
    )
    assert cost == 20 * MICRO_USD_PER_USD


def test_a_provider_that_does_not_bill_per_token_costs_nothing():
    # Zero by declaration (a local Ollama), never by a missing price.
    usage = TokenUsage(prompt_tokens=1_000_000, completion_tokens=1_000_000)
    assert estimate_cost_micro_usd("llama3.2", usage, {}, charges_per_token=False) == 0


def test_the_vendor_prefix_is_optional_when_looking_up_a_price():
    # "claude-sonnet-4.5" and "anthropic/claude-sonnet-4.5" are one model at one
    # rate; requiring both spellings would unprice it on a provider switch.
    assert price_for("claude-sonnet-4.5", DEFAULT_MODEL_PRICES) is not None
    assert price_for("openrouter/openai/gpt-4o-mini", DEFAULT_MODEL_PRICES) is not None


# -- the configured table -----------------------------------------------------


def test_configured_prices_layer_over_the_defaults():
    prices = parse_model_prices("anthropic/claude-sonnet-4.5=4/20, new/model=1/2")
    assert prices["anthropic/claude-sonnet-4.5"] == ModelPrice(Decimal("4"), Decimal("20"))
    assert prices["new/model"] == ModelPrice(Decimal("1"), Decimal("2"))
    # An entry that was not overridden keeps its documented default.
    assert prices["openai/gpt-4o-mini"] == DEFAULT_MODEL_PRICES["openai/gpt-4o-mini"]


def test_an_empty_setting_leaves_the_defaults_alone():
    assert parse_model_prices("") == DEFAULT_MODEL_PRICES


@pytest.mark.parametrize(
    "raw",
    ["anthropic/claude-sonnet-4.5", "model=3", "model=three/15", "=3/15", "model=-3/15"],
)
def test_a_malformed_price_fails_at_boot(raw: str):
    # Dropping a bad entry silently would downgrade the model to the pessimistic
    # rate and make a typo look like a budget that empties for no reason.
    with pytest.raises(ValueError):
        build(llm_model_prices=raw)


def test_settings_expose_the_parsed_table():
    settings = build(llm_model_prices="new/model=1/2")
    assert settings.llm_model_price_map["new/model"] == ModelPrice(Decimal("1"), Decimal("2"))


def test_the_daily_budget_is_a_decimal_never_a_float():
    # Guideline 3: money is Decimal in Python, always.
    assert isinstance(build(llm_daily_budget_usd="2.50").llm_daily_budget_usd, Decimal)
