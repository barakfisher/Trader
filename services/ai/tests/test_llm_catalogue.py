"""The models the Admin page offers (D43)."""

from __future__ import annotations

from decimal import Decimal

from app.llm.catalogue import CATALOGUE, SCOPES, offered_models
from app.llm.pricing import DEFAULT_MODEL_PRICES, ModelPrice, is_declared_free


def test_every_catalogued_model_is_priced_by_default():
    # An unpriced model would be charged the pessimistic rate (pricing.py).
    assert [offered.model for offered in offered_models(DEFAULT_MODEL_PRICES)] == list(CATALOGUE)


def test_a_model_without_a_price_is_not_offered():
    sonnet = CATALOGUE[0]
    prices = {sonnet.id: ModelPrice(Decimal("2"), Decimal("10"))}
    offered = [offered.model.id for offered in offered_models(prices)]
    # The free route prices itself (its suffix is the price); nothing else here has one.
    assert offered == [sonnet.id] + [m.id for m in CATALOGUE if is_declared_free(m.id)]


def test_agents_are_offered_only_billed_models_that_call_tools():
    for offered in offered_models(DEFAULT_MODEL_PRICES):
        if "agent" in offered.scopes:
            assert offered.model.supports_tools and not offered.free
        else:
            assert offered.scopes == ("explain",)


def test_the_default_recommendation_comes_first_and_serves_both_scopes():
    [first, *_] = offered_models(DEFAULT_MODEL_PRICES)
    assert first.model.id == "anthropic/claude-sonnet-5.5"
    assert first.scopes == SCOPES
