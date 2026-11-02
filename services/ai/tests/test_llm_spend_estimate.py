"""What one agent scan is estimated to cost (D44, D46)."""

from __future__ import annotations

from decimal import Decimal

from app.llm.base import MICRO_USD_PER_USD
from app.llm.pricing import ModelPrice
from app.llm.spend_estimate import (
    ASSUMED_SCAN_COMPLETION_TOKENS,
    ASSUMED_SCAN_PROMPT_TOKENS,
    DEFAULT_SCANS_PER_DAY,
    AgentBasis,
    scan_estimate_micro_usd,
)

PRICE = ModelPrice(Decimal("2"), Decimal("10"))


def _usd_micro(prompt: Decimal, completion: Decimal) -> Decimal:
    return (
        (prompt * PRICE.prompt_usd_per_mtok + completion * PRICE.completion_usd_per_mtok)
        / Decimal(1_000_000)
        * MICRO_USD_PER_USD
    )


def _basis(prompt: int, completion: int) -> AgentBasis:
    return AgentBasis(
        scanning_agents=1,
        scans_per_day=DEFAULT_SCANS_PER_DAY,
        prompt_tokens_per_scan=prompt,
        completion_tokens_per_scan=completion,
        source="assumed",
    )


def test_a_scan_prices_the_tokens_of_one():
    basis = _basis(ASSUMED_SCAN_PROMPT_TOKENS, ASSUMED_SCAN_COMPLETION_TOKENS)
    assert scan_estimate_micro_usd(basis, PRICE) == int(
        _usd_micro(Decimal(ASSUMED_SCAN_PROMPT_TOKENS), Decimal(ASSUMED_SCAN_COMPLETION_TOKENS))
    )


def test_an_estimate_rounds_up_once():
    # One token at $2 per million is 2 micro-USD; at $10 it is 10 - whole, so exact.
    assert scan_estimate_micro_usd(_basis(1, 0), PRICE) == 2
    # A model at a fraction of a micro-USD per token rounds up to one.
    cheap = ModelPrice(Decimal("0.1"), Decimal("0"))
    assert scan_estimate_micro_usd(_basis(1, 0), cheap) == 1
