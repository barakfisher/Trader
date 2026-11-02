"""The models that stand in for OpenRouter's list until it is read (D283)."""

from __future__ import annotations

from app.llm.catalogue import CATALOGUE
from app.llm.pricing import DEFAULT_MODEL_PRICES, price_for


def test_every_catalogued_model_is_priced_by_default():
    # An unpriced model would be charged the pessimistic rate (pricing.py).
    assert [m for m in CATALOGUE if price_for(m.id, DEFAULT_MODEL_PRICES) is None] == []
